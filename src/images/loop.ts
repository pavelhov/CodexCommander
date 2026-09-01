/**
 * Compatibility exports for callers that still import the historical image-loop module.
 * The request-level model loop is owned by the neutral Responses auxiliary coordinator.
 */
export {
  clampImageMaxRounds,
  DEFAULT_MAX_ROUNDS,
  MAX_IMAGE_CALLS_PER_TURN,
  MAX_ROUNDS_HARD_LIMIT,
  MAX_VIDEO_CALLS_PER_TURN,
  runResponsesAuxiliaryLoop,
  runWithImageBridge,
} from "../responses/auxiliary";
export type { ImageBridgeDeps, ResponsesAuxiliaryLoopDeps } from "../responses/auxiliary";
