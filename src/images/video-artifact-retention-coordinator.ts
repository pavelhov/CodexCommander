import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import {
  pruneMediaArtifacts,
  unlinkMediaArtifactDurably,
  type ArtifactPinAuthority,
  type ArtifactPinFinalizeResult,
  type ArtifactPinPreflightResult,
  type ArtifactPinReleaseResult,
  type ArtifactRetentionIo,
} from "./artifact-retention";
import { DEFAULT_ARTIFACT_KEEP_COUNT, getArtifactsDir } from "./artifacts";
import type { VideoJobStore } from "./video-job-store";

const STARTUP_PRIVATE_VIDEO_TEMP_AGE_MS = 24 * 60 * 60_000;
const STARTUP_PRIVATE_VIDEO_TEMP_LIMIT = 32;

export interface VideoArtifactRetentionCoordinatorOptions {
  store: VideoJobStore;
  /** Shared image/video artifact cap. Defaults to the canonical retention limit. */
  artifactsKeepCount?: number;
  /** Test-only durable artifact deletion fault seam. */
  artifactRetentionIo?: ArtifactRetentionIo;
}

function ensurePrivateArtifactsDirectory(dir: string): boolean {
  try {
    recordOwnedConfigPath(getConfigDir(), dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let stats = lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    if (process.platform === "win32") {
      if (!hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::artifacts` }).ok) return false;
    } else {
      chmodSync(dir, 0o700);
    }
    stats = lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime-local owner for transient delivery/publication pins and serialized
 * image/video retention. Durable job transitions stay with MediaRuntime.
 */
export class VideoArtifactRetentionCoordinator implements ArtifactPinAuthority {
  readonly #store: VideoJobStore;
  readonly #artifactsKeepCount: number;
  readonly #artifactRetentionIo: ArtifactRetentionIo;
  readonly #pendingDeliveryArtifactIds = new Set<string>();
  readonly #pendingLatePublicationArtifactIds = new Set<string>();
  readonly #artifactDeliveryLeaseCounts = new Map<string, number>();
  readonly #artifactCleanupFlights = new Set<Promise<void>>();
  #retentionTail: Promise<void> | undefined;
  #startupTempCleanupPending = true;
  #closed = false;

  constructor(options: VideoArtifactRetentionCoordinatorOptions) {
    this.#store = options.store;
    this.#artifactsKeepCount = typeof options.artifactsKeepCount === "number"
      && Number.isSafeInteger(options.artifactsKeepCount)
      ? options.artifactsKeepCount
      : DEFAULT_ARTIFACT_KEEP_COUNT;
    this.#artifactRetentionIo = options.artifactRetentionIo ?? {};
  }

  markDeliveryPending(artifactId: string): void {
    if (!this.#closed) this.#pendingDeliveryArtifactIds.add(artifactId);
  }

  releaseDeliveryPendingAfterTurn(artifactId: string): void {
    const timer = setTimeout(() => {
      if (!this.#artifactDeliveryLeaseCounts.has(artifactId)) {
        this.#pendingDeliveryArtifactIds.delete(artifactId);
      }
    }, 0);
    timer.unref?.();
  }

  acquireArtifactDeliveryLease(artifactId: string): () => void {
    const ownsCompletedArtifact = this.#store.listVideoJobs()
      .some(job => job.state === "completed" && job.artifactId === artifactId);
    if (!ownsCompletedArtifact || this.#closed) return () => {};
    this.#artifactDeliveryLeaseCounts.set(
      artifactId,
      (this.#artifactDeliveryLeaseCounts.get(artifactId) ?? 0) + 1,
    );
    this.#pendingDeliveryArtifactIds.add(artifactId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.#artifactDeliveryLeaseCounts.get(artifactId) ?? 1) - 1;
      if (remaining > 0) {
        this.#artifactDeliveryLeaseCounts.set(artifactId, remaining);
        return;
      }
      this.#artifactDeliveryLeaseCounts.delete(artifactId);
      this.#pendingDeliveryArtifactIds.delete(artifactId);
    };
  }

  #trackArtifactCleanup(flight: Promise<void>): void {
    const settled = flight.catch(() => { /* the durable obligation is retried by retention/startup */ });
    this.#artifactCleanupFlights.add(settled);
    void settled.then(() => this.#artifactCleanupFlights.delete(settled));
  }

  #cleanupUnreservedLatePath(latePath: string | undefined): void {
    if (!latePath || latePath.length > 4_096) return;
    const dir = getArtifactsDir();
    const lateArtifactId = basename(latePath);
    if (resolve(latePath) !== resolve(dir, lateArtifactId)) return;
    unlinkMediaArtifactDurably(dir, lateArtifactId, this.#artifactRetentionIo);
  }

  /** Keep a reserved id pinned until its producer can no longer publish it. */
  trackLatePublication(artifactId: string | undefined, lateDownload: Promise<string>): void {
    if (this.#closed) return;
    if (artifactId) this.#pendingLatePublicationArtifactIds.add(artifactId);
    const cleanup = (async () => {
      let latePath: string | undefined;
      try {
        latePath = await lateDownload;
      } catch {
        // A rejected producer cannot publish a returned compatibility path.
      }
      if (artifactId) {
        this.#pendingLatePublicationArtifactIds.delete(artifactId);
        await this.run();
        return;
      }
      // Production reserves before publication. For an injected/legacy
      // downloader that returns a late unreserved path, clean only one bounded
      // regular artifact name inside the canonical artifact directory.
      this.#cleanupUnreservedLatePath(latePath);
    })();
    this.#trackArtifactCleanup(cleanup);
  }

  /** Clean a cancelled compatibility downloader only when it had no reservation. */
  trackUnreservedLatePublication(lateDownload: Promise<string>): void {
    if (this.#closed) return;
    const cleanup = (async () => {
      let latePath: string | undefined;
      try {
        latePath = await lateDownload;
      } catch {
        return;
      }
      this.#cleanupUnreservedLatePath(latePath);
    })();
    this.#trackArtifactCleanup(cleanup);
  }

  /** Await a cancelled reserved producer without pruning its durable reservation. */
  trackReservedLatePublication(lateDownload: Promise<string>): void {
    if (this.#closed) return;
    const cleanup = (async () => {
      try {
        await lateDownload;
      } catch {
        // A rejected producer cannot leave a later publication behind.
      }
    })();
    this.#trackArtifactCleanup(cleanup);
  }

  protectedArtifactIds(): ReadonlySet<string> {
    return new Set([
      ...this.#store.protectedArtifactIds(),
      ...this.#pendingDeliveryArtifactIds,
      ...this.#pendingLatePublicationArtifactIds,
    ]);
  }

  recoverablePublicationArtifactIds(): ReadonlySet<string> {
    return this.#store.recoverablePublicationArtifactIds();
  }

  expiredLinkedPublicationArtifactIds(): ReadonlySet<string> {
    return this.#store.expiredLinkedPublicationArtifactIds();
  }

  canReleaseArtifactForPrune(artifactId: string): ArtifactPinPreflightResult {
    if (
      this.#pendingDeliveryArtifactIds.has(artifactId)
      || this.#pendingLatePublicationArtifactIds.has(artifactId)
    ) return "protected";
    return this.#store.canReleaseArtifactForPrune(artifactId);
  }

  releaseArtifactForPrune(artifactId: string): ArtifactPinReleaseResult {
    if (
      this.#pendingDeliveryArtifactIds.has(artifactId)
      || this.#pendingLatePublicationArtifactIds.has(artifactId)
    ) return "protected";
    return this.#store.releaseArtifactForPrune(artifactId);
  }

  pendingArtifactDeletionIds(): ReadonlySet<string> {
    return this.#store.pendingArtifactDeletionIds();
  }

  finalizeArtifactPrune(artifactId: string): ArtifactPinFinalizeResult {
    return this.#store.finalizeArtifactPrune(artifactId);
  }

  /** One serialized runtime-owned retention pass. */
  run(): Promise<void> {
    const previous = this.#retentionTail ?? Promise.resolve();
    const run = previous.then(() => {
      if (this.#closed) return;
      const dir = getArtifactsDir();
      if (!existsSync(dir)) {
        if (this.#store.pendingArtifactDeletionIds().size === 0) {
          this.#startupTempCleanupPending = false;
          return;
        }
      }
      // Validate/harden on every pass. In particular, an existing symlink is
      // rejected before enumeration, and Windows ACL ownership is reasserted.
      if (!ensurePrivateArtifactsDirectory(dir)) return;
      const cleanStartupTemps = this.#startupTempCleanupPending;
      const result = pruneMediaArtifacts({
        dir,
        maxFiles: this.#artifactsKeepCount,
        protectedArtifactIds: new Set([
          ...this.#pendingDeliveryArtifactIds,
          ...this.#pendingLatePublicationArtifactIds,
        ]),
        pinAuthorities: [this],
        io: this.#artifactRetentionIo,
        ...(cleanStartupTemps ? {
          staleTempAgeMs: STARTUP_PRIVATE_VIDEO_TEMP_AGE_MS,
          maxStaleTemps: STARTUP_PRIVATE_VIDEO_TEMP_LIMIT,
        } : {}),
      });
      if (cleanStartupTemps && !result.blocked) this.#startupTempCleanupPending = false;
    });
    const settled = run.catch(() => { /* a later pass can retry */ });
    this.#retentionTail = settled;
    void settled.then(() => {
      if (this.#retentionTail === settled) this.#retentionTail = undefined;
    });
    return settled;
  }

  /** Runtime-owned cleanup and retention work still unsettled at this instant. */
  pendingFlights(): readonly Promise<void>[] {
    return [...new Set([
      ...this.#artifactCleanupFlights,
      ...(this.#retentionTail ? [this.#retentionTail] : []),
    ])];
  }

  close(): void {
    if (this.pendingFlights().length !== 0) {
      throw new Error("video artifact retention still has pending work");
    }
    this.#closed = true;
    this.#pendingDeliveryArtifactIds.clear();
    this.#pendingLatePublicationArtifactIds.clear();
    this.#artifactDeliveryLeaseCounts.clear();
  }
}
