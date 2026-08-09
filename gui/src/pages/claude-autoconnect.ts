/** Validate the current Auto-connect response contract. */
export function reconcileAutoConnectState(response: {
  autoConnectSupported: unknown;
  systemEnv: unknown;
}): { autoConnectSupported: boolean; systemEnv: boolean } {
  if (typeof response.autoConnectSupported !== "boolean" || typeof response.systemEnv !== "boolean") {
    throw new Error("invalid Claude Code Auto-connect response");
  }
  const autoConnectSupported = response.autoConnectSupported;
  return {
    autoConnectSupported,
    systemEnv: autoConnectSupported && response.systemEnv,
  };
}
