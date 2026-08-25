// AUTO-SPLIT facade: original responses.ts body moved into ./responses/* modules.
// Importers keep using "src/server/responses"; the obsolete V2 guidance budget is intentionally gone.
export { buildToolBridgeMaps, isV1CollabSurface, collabSurface, multiAgentGuidanceText, injectDeveloperMessage } from "./responses/collaboration";
export type { MultiAgentGuidanceOptions, MultiAgentGuidanceDeps } from "./responses/collaboration";
export { hasUnreadableEncryptedAgentTask, sanitizeEncryptedContentInPlace } from "./responses/encrypted-payload";
export { COMPACT_RESPONSE_MAX_BYTES, bufferCompactResponse, handleResponsesCompact } from "./responses/compact";
export { disableResponsesRequestTimeout, safeHostLabel, fetchWithHeaderTimeout } from "./responses/fetch-helpers";
export { sidecarOutcomeRecorder, isShadowSourceModel, codexLogAccountId, usesCodexForwardPoolAuth, codexForwardTerminalOutcomeRecorder, decodeRequestErrorResponse, buildComboChildHeaders, handleResponses, linkAbortSignal } from "./responses/core";
export { adapterNeedsForcedContinuation } from "./responses/core";
