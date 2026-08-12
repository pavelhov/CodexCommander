import {
  PROXY_START_LOCK_WAIT_MS,
  acquireProxyEnsureLock,
  acquireProxyStartLock,
  type ProxyStartLock,
  type ProxyStartLockOptions,
} from "./proxy-start-lock";
import type { ProxyLifecycleLockLease } from "./proxy-lifecycle-protocol";

type ProxyLockAcquirer = (options?: ProxyStartLockOptions) => Promise<ProxyStartLock>;

export interface AcquireProxyLifecycleAuthorityOptions {
  /** Acquire S immediately after E. */
  includeStart?: boolean;
  /** Absolute acquisition deadline shared by the initial E and S attempts. */
  deadlineAt?: number;
  /** Used to derive deadlineAt when an absolute deadline is not supplied. */
  waitTimeoutMs?: number;
  now?: () => number;
  acquireEnsureLock?: ProxyLockAcquirer;
  acquireStartLock?: ProxyLockAcquirer;
}

export interface ProxyLifecycleStartAcquisitionOptions {
  deadlineAt?: number;
  waitTimeoutMs?: number;
}

export interface ProxyLifecycleAuthority {
  /** The initial pair-acquisition deadline. */
  readonly deadlineAt: number;
  /** Releasing this handle releases S first, then E. */
  readonly ensure: ProxyStartLock;
  /** Releasing this handle releases only the currently represented S lease. */
  readonly start: ProxyStartLock | undefined;
  /** Acquire or reacquire S while retaining E. Concurrent calls share one attempt. */
  acquireStart(options?: ProxyLifecycleStartAcquisitionOptions): Promise<ProxyStartLock>;
  /** A fresh proof is available only while this authority still owns both E and S. */
  delegatedLease(): ProxyLifecycleLockLease | undefined;
  releaseStart(): void;
  releaseAll(): void;
}

export class ProxyLifecycleAuthorityError extends Error {
  readonly code = "PROXY_LIFECYCLE_AUTHORITY_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyLifecycleAuthorityError";
  }
}

function acquisitionError(message: string, cause: unknown): ProxyLifecycleAuthorityError {
  return cause instanceof ProxyLifecycleAuthorityError
    ? cause
    : new ProxyLifecycleAuthorityError(message, { cause });
}

function resolveDeadline(
  now: () => number,
  options: { deadlineAt?: number; waitTimeoutMs?: number },
): number {
  const current = now();
  const waitTimeoutMs = options.waitTimeoutMs ?? PROXY_START_LOCK_WAIT_MS;
  if (!Number.isFinite(current)
    || !Number.isFinite(waitTimeoutMs)
    || waitTimeoutMs < 0
    || (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))) {
    throw new ProxyLifecycleAuthorityError("Invalid proxy lifecycle authority timing options");
  }
  return options.deadlineAt ?? current + waitTimeoutMs;
}

function remainingWaitMs(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now());
}

interface HeldStartLock {
  readonly raw: ProxyStartLock;
  readonly exposed: ProxyStartLock;
}

class HeldProxyLifecycleAuthority implements ProxyLifecycleAuthority {
  readonly deadlineAt: number;
  readonly ensure: ProxyStartLock;

  private ensureRaw: ProxyStartLock | undefined;
  private heldStart: HeldStartLock | undefined;
  private startAcquisition: Promise<ProxyStartLock> | undefined;
  private startEpoch = 0;
  private allReleased = false;

  constructor(
    ensure: ProxyStartLock,
    deadlineAt: number,
    private readonly now: () => number,
    private readonly acquireStartLock: ProxyLockAcquirer,
  ) {
    this.ensureRaw = ensure;
    this.deadlineAt = deadlineAt;
    this.ensure = {
      token: ensure.token,
      release: (): void => this.releaseAll(),
    };
  }

  get start(): ProxyStartLock | undefined {
    return this.heldStart?.exposed;
  }

  async acquireStart(
    options: ProxyLifecycleStartAcquisitionOptions = {},
  ): Promise<ProxyStartLock> {
    const existing = this.heldStart?.exposed;
    if (existing) return existing;
    if (this.allReleased || !this.ensureRaw) {
      throw new ProxyLifecycleAuthorityError(
        "Cannot acquire proxy start authority after lifecycle authority was released",
      );
    }
    if (this.startAcquisition) return this.startAcquisition;
    const deadlineAt = resolveDeadline(this.now, options);
    return this.acquireStartBefore(deadlineAt);
  }

  async acquireInitialStart(): Promise<ProxyStartLock> {
    return this.acquireStartBefore(this.deadlineAt);
  }

  delegatedLease(): ProxyLifecycleLockLease | undefined {
    const ensure = this.ensureRaw;
    const start = this.heldStart;
    if (this.allReleased || !ensure || !start) return undefined;
    // Never cache this object: releaseStart/releaseAll revoke proof immediately,
    // and a later S acquisition receives a new token and a new proof.
    return { ensureToken: ensure.token, startToken: start.raw.token };
  }

  releaseStart(): void {
    this.startEpoch += 1;
    const held = this.heldStart;
    this.heldStart = undefined;
    held?.raw.release();
  }

  releaseAll(): void {
    if (this.allReleased) return;
    this.allReleased = true;
    this.startEpoch += 1;
    const held = this.heldStart;
    this.heldStart = undefined;
    try {
      held?.raw.release();
    } finally {
      // A low-level S acquisition cannot be cancelled. Retain E until that
      // attempt settles, then its completion path releases S before E.
      if (!this.startAcquisition) this.releaseEnsureRaw();
    }
  }

  private acquireStartBefore(deadlineAt: number): Promise<ProxyStartLock> {
    const ensureAtAdmission = this.ensureRaw;
    if (this.allReleased || !ensureAtAdmission) {
      return Promise.reject(new ProxyLifecycleAuthorityError(
        "Cannot acquire proxy start authority after lifecycle authority was released",
      ));
    }
    if (this.startAcquisition) return this.startAcquisition;
    const admittedAt = this.now();
    if (admittedAt > deadlineAt) {
      return Promise.reject(new ProxyLifecycleAuthorityError(
        "Proxy lifecycle authority deadline expired before start authority could be acquired",
      ));
    }
    const epochAtAdmission = this.startEpoch;
    const pending = Promise.resolve().then(() => this.acquireStartLock({
      waitTimeoutMs: Math.max(0, deadlineAt - admittedAt),
      now: this.now,
    })).then(raw => {
      if (this.now() > deadlineAt) {
        raw.release();
        throw new ProxyLifecycleAuthorityError(
          "Proxy lifecycle authority deadline expired while start authority was being acquired",
        );
      }
      if (this.ensureRaw !== ensureAtAdmission || this.startEpoch !== epochAtAdmission) {
        raw.release();
        throw new ProxyLifecycleAuthorityError(
          "Proxy lifecycle authority was released while start authority was being acquired",
        );
      }
      const exposed: ProxyStartLock = {
        token: raw.token,
        release: (): void => this.releaseSpecificStart(raw),
      };
      this.heldStart = { raw, exposed };
      return exposed;
    }, error => {
      throw acquisitionError("Could not acquire proxy start authority", error);
    });
    this.startAcquisition = pending;
    void pending.finally(() => {
      if (this.startAcquisition === pending) this.startAcquisition = undefined;
      if (this.allReleased) this.releaseEnsureRaw();
    }).catch(() => {});
    return pending;
  }

  private releaseSpecificStart(raw: ProxyStartLock): void {
    if (this.heldStart?.raw !== raw) return;
    this.releaseStart();
  }

  private releaseEnsureRaw(): void {
    const ensure = this.ensureRaw;
    this.ensureRaw = undefined;
    ensure?.release();
  }
}

/**
 * Acquire the lifecycle hierarchy in its sole valid order, E then optional S.
 * The initial pair shares one absolute deadline and a partial acquisition is
 * always rolled back. All acquisition failures use one predictable error type;
 * the underlying ProxyStartLockError remains available as `cause`.
 */
export async function acquireProxyLifecycleAuthority(
  options: AcquireProxyLifecycleAuthorityOptions = {},
): Promise<ProxyLifecycleAuthority> {
  const now = options.now ?? Date.now;
  const deadlineAt = resolveDeadline(now, options);
  const acquireEnsure = options.acquireEnsureLock ?? acquireProxyEnsureLock;
  const acquireStart = options.acquireStartLock ?? acquireProxyStartLock;
  let ensure: ProxyStartLock;
  try {
    ensure = await acquireEnsure({
      waitTimeoutMs: remainingWaitMs(deadlineAt, now),
      now,
    });
  } catch (error) {
    throw acquisitionError("Could not acquire proxy ensure authority", error);
  }

  const authority = new HeldProxyLifecycleAuthority(ensure, deadlineAt, now, acquireStart);
  if (!options.includeStart) return authority;
  try {
    await authority.acquireInitialStart();
    return authority;
  } catch (error) {
    try { authority.releaseAll(); } catch { /* preserve the acquisition failure */ }
    throw acquisitionError("Could not acquire proxy lifecycle authority", error);
  }
}
