/**
 * Minimal catalog admission for the management refresh path.
 *
 * The r2 #1 catalog incident left gather and native writes in one awaited
 * callback. WP9 needs generation and filesystem-target evidence before it can
 * split those phases, but importing WP12 authority would make WP9 depend on a
 * later phase. This reader therefore captures only the exact resident config,
 * its cooperating generation, and identities for catalog-owned targets.
 */
import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import {
  observeConfigGeneration,
  readConfigAdmissionSnapshot,
  readConfigGenerationInCurrentMutationTransaction,
  validateConfigCandidate,
  withConfigMutationLockSync,
} from "../config";
import type { CodexCommanderConfig } from "../types";
import type {
  CatalogAdmissionSnapshot,
  CatalogConvergeRequestInput,
  ConfigGeneration,
  ConvergeRequest,
} from "./convergence-types";
import {
  catalogBackupPathFor,
} from "./catalog/parsing";
import { readRootTomlString } from "./paths";
import {
  acceptCatalogGatherSourcePath,
  captureAndSealCatalogHomeSelection,
  captureCatalogGatherTargetIdentity,
  createCatalogGatherEvidenceSession,
  readCatalogGatherSource,
  sealCatalogGatherEvidenceSession,
} from "./catalog/filesystem-evidence";

/**
 * Construct the one request shape permitted for management catalog refreshes.
 * Callers choose the deadline only; they cannot widen scope or choose direction.
 */
export function createCatalogConvergeRequest({
  deadlineMs,
}: CatalogConvergeRequestInput): ConvergeRequest {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError("Catalog convergence deadlineMs must be a positive safe integer.");
  }

  return {
    action: "converge",
    scope: "catalog",
    reason: "management-mutation",
    mode: "automatic",
    deadlineMs,
  };
}

const CONFIG_IDENTITY_KEY = randomBytes(32);
const configReferenceIdentities = new WeakMap<object, string>();
let nextConfigReferenceIdentity = 0;

export class CatalogAdmissionStaleConfigError extends Error {
  constructor() {
    super("Cannot capture Codex catalog admission: the supplied config snapshot is stale.");
    this.name = "CatalogAdmissionStaleConfigError";
  }
}

export interface CatalogConfigAuthoritySnapshot {
  /** Monotonic cooperating-write fence; include this in optimistic revisions. */
  readonly generation: ConfigGeneration;
  /** Process-keyed semantic config identity, safe to compare or hash but not decode. */
  readonly semanticIdentity: string;
  /** Process-keyed identity of the exact persisted bytes read with this authority. */
  readonly contentIdentity: string;
}

function encodeLengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function canonicalConfigEncoding(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined": return "undefined";
    case "boolean": return value ? "boolean:1" : "boolean:0";
    case "string": return `string:${encodeLengthPrefixed(value)}`;
    case "number": {
      if (!Number.isFinite(value)) throw new TypeError("Catalog config identity cannot encode a non-finite number.");
      return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
    }
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`Catalog config identity cannot encode ${typeof value}.`);
    case "object": break;
  }

  if (ancestors.has(value)) throw new TypeError("Catalog config identity cannot encode a cyclic graph.");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Catalog config identity cannot encode symbol keys.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = Array.from({ length: value.length }, (_, index) => (
        Object.hasOwn(value, index)
          ? `item:${canonicalConfigEncoding(value[index], ancestors)}`
          : "hole"
      ));
      return `array:${value.length}:${items.map(encodeLengthPrefixed).join("")}`;
    }
    const keys = Object.keys(value).sort();
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Catalog config identity cannot encode accessor properties.");
      }
      return `${encodeLengthPrefixed(key)}${encodeLengthPrefixed(canonicalConfigEncoding(descriptor.value, ancestors))}`;
    });
    return `object:${keys.length}:${entries.join("")}`;
  } finally {
    ancestors.delete(value);
  }
}

function keyedConfigIdentity(domain: string, payload: string): string {
  return createHmac("sha256", CONFIG_IDENTITY_KEY)
    .update(encodeLengthPrefixed(domain))
    .update(encodeLengthPrefixed(payload))
    .digest("hex");
}

function catalogConfigIdentity(
  config: Readonly<CodexCommanderConfig>,
  generation: ConfigGeneration,
  authority: CatalogConfigAuthoritySnapshot,
): CatalogAdmissionSnapshot["configIdentity"] {
  let referenceIdentity = configReferenceIdentities.get(config);
  if (!referenceIdentity) {
    nextConfigReferenceIdentity += 1;
    referenceIdentity = keyedConfigIdentity("catalog-config-reference-v1", String(nextConfigReferenceIdentity));
    configReferenceIdentities.set(config, referenceIdentity);
  }
  return Object.freeze({
    referenceIdentity,
    generation: Object.freeze({ ...generation }),
    snapshotIdentity: authority.semanticIdentity,
    contentIdentity: authority.contentIdentity,
  });
}

/**
 * Atomically bind a supplied decoded config to the persisted bytes and their
 * monotonic generation. Direct/manual semantic byte drift is refused even when
 * a non-cooperating editor did not bump the generation.
 */
export function captureCatalogConfigAuthority(
  config: Readonly<CodexCommanderConfig>,
): CatalogConfigAuthoritySnapshot {
  // Unlike full catalog admission, status/revision observation is allowed to
  // initialize generation zero for a valid pre-coordinator installation.
  return withConfigMutationLockSync(() => {
    const persisted = readConfigAdmissionSnapshot();
    const normalized = validateConfigCandidate(config);
    const persistedFile = persisted.kind === "read"
      && persisted.diagnostics.source === "file"
      && persisted.diagnostics.error === null;
    const persistedAbsent = persisted.kind === "unreadable"
      && persisted.diagnostics.source === "default"
      && persisted.diagnostics.error === null;
    if (
      (!persistedFile && !persistedAbsent)
      || !normalized.ok
      || canonicalConfigEncoding(persisted.diagnostics.config)
        !== canonicalConfigEncoding(normalized.config)
    ) {
      throw new CatalogAdmissionStaleConfigError();
    }
    const normalizedEncoding = canonicalConfigEncoding(normalized.config);
    return Object.freeze({
      generation: Object.freeze({ ...readConfigGenerationInCurrentMutationTransaction() }),
      semanticIdentity: keyedConfigIdentity(
        "catalog-config-snapshot-v1",
        normalizedEncoding,
      ),
      contentIdentity: keyedConfigIdentity(
        "catalog-config-content-v1",
        persistedFile ? persisted.contentSha256 : "absent",
      ),
    });
  });
}

/**
 * Capture the catalog-only evidence WP9 can validate without consulting WP12.
 * The config reference is retained verbatim; no persisted config re-read may
 * replace the object already held by the management callback.
 */
export function captureCatalogAdmissionSnapshot(
  config: Readonly<CodexCommanderConfig>,
): CatalogAdmissionSnapshot {
  const observedGeneration = observeConfigGeneration();
  if (observedGeneration.kind === "absent") {
    /*
     * Absence is refused HERE and admitted elsewhere, and the difference is the
     * lock. Codex write admission may carry an absent generation because it goes
     * on to take the config transaction and read a real zero inside it. Catalog
     * gather has no such transaction — by contract it holds no lock and writes
     * nothing — so it has no way to turn absence into an observation. Refusing
     * is the only honest answer available to it.
     *
     * The wording matters beyond this line: `admissionFailure` in
     * management-convergence.ts classifies this throw by matching its MESSAGE,
     * and an unrecognized one becomes a non-retryable `failed/disk` instead of
     * the retryable skip a missing coordinator has always produced. Keeping the
     * "config generation is database" phrasing preserves that projection — a
     * caller that could simply try again should still be told to.
     */
    throw new Error("Cannot capture Codex catalog admission: config generation is database (absent).");
  }
  if (observedGeneration.kind !== "ready") {
    throw new Error(`Cannot capture Codex catalog admission: config generation is ${observedGeneration.reason}.`);
  }

  const authority = captureCatalogConfigAuthority(config);
  const generation = authority.generation;

  const evidenceSession = createCatalogGatherEvidenceSession();
  const homeSelection = captureAndSealCatalogHomeSelection(evidenceSession);
  const configPath = join(homeSelection.canonicalCodexHome, "config.toml");
  acceptCatalogGatherSourcePath(evidenceSession, "catalog-target-selection", configPath);
  const configBytes = readCatalogGatherSource(evidenceSession, "catalog-target-selection");
  const configuredCatalogPath = configBytes === null
    ? null
    : readRootTomlString(Buffer.from(configBytes).toString("utf8"), "model_catalog_json");
  const defaultCatalogPath = join(homeSelection.canonicalCodexHome, "codexcommander-catalog.json");
  const catalogPath = configuredCatalogPath
    ? resolve(homeSelection.canonicalCodexHome, configuredCatalogPath)
    : defaultCatalogPath;
  const backupPaths = [catalogBackupPathFor(catalogPath)];
  const targets = {
    catalog: captureCatalogGatherTargetIdentity(evidenceSession, catalogPath),
    cache: captureCatalogGatherTargetIdentity(
      evidenceSession,
      join(homeSelection.canonicalCodexHome, "models_cache.json"),
    ),
    catalogBackups: backupPaths.map(path => captureCatalogGatherTargetIdentity(evidenceSession, path)),
  };
  const sourceEvidence = sealCatalogGatherEvidenceSession(evidenceSession);

  return {
    config,
    generation,
    configIdentity: catalogConfigIdentity(config, generation, authority),
    targets,
    sourceEvidence,
  };
}
