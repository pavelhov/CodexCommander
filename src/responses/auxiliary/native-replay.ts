function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface NativeAuxiliaryReplayPair {
  call: Record<string, unknown>;
  output: Record<string, unknown>;
}

/** Build an exact Responses function-call replay pair without chat translation. */
export function nativeAuxiliaryReplayPair(
  callItem: unknown,
  output: string,
): NativeAuxiliaryReplayPair | undefined {
  const call = record(callItem);
  if (!call || call.type !== "function_call" || typeof call.call_id !== "string" || typeof call.name !== "string") {
    return undefined;
  }
  return {
    call: { ...call },
    output: { type: "function_call_output", call_id: call.call_id, output },
  };
}

/** Append replay items to a clone while preserving every pre-existing native item. */
export function appendNativeAuxiliaryReplay(
  body: unknown,
  pairs: readonly NativeAuxiliaryReplayPair[],
): unknown {
  const source = record(body);
  if (!source || !Array.isArray(source.input) || pairs.length === 0) return body;
  return {
    ...source,
    input: [...source.input, ...pairs.flatMap(pair => [pair.call, pair.output])],
  };
}
