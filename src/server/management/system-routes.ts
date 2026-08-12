/**
 * /api/system/* — service-process runtime/memory introspection (#314 WP3)
 * and the memory-card canonical restart action (#563).
 *
 * Rides the standard management gate: every /api/* request already passed
 * the independent management-auth gate + the origin check before dispatch, so these
 * routes add no auth of their own. NEVER expose this data on the
 * unauthenticated /healthz surface.
 *
 * The payload is scalar-only (numbers, enum strings, booleans): no paths, no
 * tokens, no account identifiers. `external` and `arrayBuffers` keep Windows
 * diagnostics honest when RSS/working-set counters under-report committed
 * retention. `jscHeap` (bun:jsc heapStats) is useful context, but on Bun 1.3.14
 * it is not a standalone leak discriminator. `responseState` attributes growth
 * further: it is the proxy's previous_response_id continuation store, so a
 * growing responseState.totalBytes under rising observed memory points at
 * conversation retention rather than the runtime allocator. Spill counts,
 * payload-byte totals, tombstones, and failure counters remain finite scalars;
 * response ids, filenames, digests, paths, and payload content never leave the owner.
 *
 * `activeTurnCount` / `isDraining` are scalar lifecycle counters for the
 * dashboard restart confirm/status UX — never request bodies or IDs.
 */
import { selectEagerPath } from "../../lib/bun-stream-caps";
import { reportedBunRuntimeSource } from "../../lib/bun-runtime";
import { getActiveTurnCount, isDraining } from "../lifecycle";
import { getActiveMemoryWatchdog, observedMemoryCounter } from "../memory-watchdog";
import { responseStateMetrics } from "../../responses/state";
import { appOwnedBytesSnapshot } from "../../lib/app-owned-memory";
import { jsonResponse } from "../auth-cors";
import { getInspectionCounters } from "../relay";
import { getEagerRelayCounters } from "../relay-eager";
import type { ManagementContext } from "./context";
import { acceptSerializedSystemRestart } from "./system-restart";

const ENDPOINT_SAMPLE_LIMIT = 60;

export async function handleSystemRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/system/memory" && req.method === "GET") {
    const usage = process.memoryUsage();
    let jscHeap: { heapSize: number; heapCapacity: number; objectCount: number } | null = null;
    try {
      const { heapStats } = await import("bun:jsc");
      const stats = heapStats();
      jscHeap = {
        heapSize: stats.heapSize,
        heapCapacity: stats.heapCapacity,
        objectCount: stats.objectCount,
      };
    } catch {
      /* non-Bun tooling or unavailable introspection — omit the discriminator */
    }
	    const watchdogInstance = getActiveMemoryWatchdog();
	    const observed = observedMemoryCounter({
	      rss: usage.rss,
	      external: usage.external,
	      arrayBuffers: usage.arrayBuffers,
	    });
    const watchdog = watchdogInstance
      ? (() => {
        const snap = watchdogInstance.snapshot();
	        return {
	          warnThresholdBytes: snap.warnThresholdBytes,
	          lastWarnAt: snap.lastWarnAt,
	          observedBytes: snap.observedBytes,
	          observedMetric: snap.observedMetric,
	          samples: snap.samples.slice(-ENDPOINT_SAMPLE_LIMIT),
	        };
      })()
      : null;
    const streamMode = config.streamMode ?? "auto";
    /** No request context exists here, so report both stable policy baselines. */
    const eagerRelay = selectEagerPath(process.platform, {
      needsClientRewrite: false,
      plaintextCollaborationRewrite: false,
    }, streamMode);
    const plaintextV2EagerRelay = config.multiAgentV2MessageDelivery === "plaintext"
      ? selectEagerPath(process.platform, {
        needsClientRewrite: true,
        plaintextCollaborationRewrite: true,
      }, streamMode)
      : null;
    return jsonResponse({
      pid: process.pid,
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      // Recorded at launch, not resolved now: absent means "this service predates the
      // marker", which callers must report as unknown rather than guess.
      bunRuntimeSource: reportedBunRuntimeSource(),
      platform: process.platform,
      uptimeSeconds: process.uptime(),
      rss: usage.rss,
      heapUsed: usage.heapUsed,
	      heapTotal: usage.heapTotal,
	      external: usage.external,
	      arrayBuffers: usage.arrayBuffers,
	      observedBytes: observed.observedBytes,
	      observedMetric: observed.observedMetric,
	      jscHeap,
      responseState: responseStateMetrics(),
      appOwnedBytes: appOwnedBytesSnapshot(),
      inspectionCounters: getInspectionCounters(),
      eagerRelayCounters: getEagerRelayCounters(),
      streamMode,
      eagerRelay,
      plaintextV2EagerRelay,
      watchdog,
      activeTurnCount: getActiveTurnCount(),
      isDraining: isDraining(),
    });
  }

  if (url.pathname === "/api/system/restart" && req.method === "POST") {
    // The serving endpoint only proves detached helper spawn. The helper owns
    // canonical safe Stop (native/OFF) -> explicit Start (ON).
    const result = await acceptSerializedSystemRestart();
    if (result.kind === "refused") {
      return jsonResponse({
        success: false,
        message: result.message,
        activeTurnCount: result.activeTurnCount,
        drainTimeoutMs: result.drainTimeoutMs,
        alreadyDraining: false,
      }, 409, req, config);
    }
    const alreadyDraining = result.kind === "already-accepted";
    return jsonResponse({
      success: true,
      message: alreadyDraining
        ? "Restart already accepted."
        : "Safe proxy restart accepted.",
      activeTurnCount: result.activeTurnCount,
      drainTimeoutMs: result.drainTimeoutMs,
      alreadyDraining,
    }, 202, req, config);
  }

  return null;
}
