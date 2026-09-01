import type { CodexCommanderProviderConfig } from "../../types";
import type { SidecarOutcomeRecorder, SidecarSettings } from "../../web-search/executor";

export type AuxiliaryHandlerName = "web_search" | "image" | "video";

export interface AuxiliaryHandlerAllowances {
  webSearch: number;
  image: number;
  video: number;
}

/** Request-private web-search execution data; credentials never enter model messages. */
export interface AuxiliaryWebSearchPlan {
  backend: "openai" | "anthropic";
  forwardProvider?: CodexCommanderProviderConfig;
  anthropicSidecar?: { providerName: string; provider: CodexCommanderProviderConfig };
  hostedTool: Record<string, unknown>;
  selectedForwardHeaders: Headers;
  settings: SidecarSettings;
  maxSearches: number;
  recordSidecarOutcome?: SidecarOutcomeRecorder;
  routedModelStallTimeoutMs?: number;
}

export interface AuxiliaryToolCall {
  id: string;
  name: string;
  args: string;
  handler: AuxiliaryHandlerName;
}
