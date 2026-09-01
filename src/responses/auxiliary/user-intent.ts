export type CurrentUserVideoIntentState = "none" | "eligible";

export interface CurrentUserVideoIntent {
  state: CurrentUserVideoIntentState;
}

function currentUserTail(rawBody: unknown): Record<string, unknown> | string | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return undefined;
  const input = (rawBody as { input?: unknown }).input;
  if (typeof input === "string") return input.trim() ? input : undefined;
  if (!Array.isArray(input) || input.length === 0) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const value = input[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (item.type === "additional_tools") continue;
    const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
    return effectiveType === "message" && item.role === "user" ? item : undefined;
  }
  return undefined;
}

function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    return (item.type === "input_text" || item.type === "text") && typeof item.text === "string"
      ? [item.text]
      : [];
  }).join("\n");
}

/** Return only text authored by the genuine current user at the request tail. */
export function currentUserAuthoredText(rawBody: unknown): string | undefined {
  const tail = currentUserTail(rawBody);
  if (typeof tail === "string") return tail.trim() || undefined;
  const text = inputText(tail?.content).trim();
  return text || undefined;
}

/** Structural current-tail provenance; media wording is deliberately irrelevant. */
export function hasGenuineCurrentUserTail(rawBody: unknown): boolean {
  const tail = currentUserTail(rawBody);
  if (typeof tail === "string") return true;
  if (!tail) return false;
  if (typeof tail.content === "string") return tail.content.trim().length > 0;
  if (!Array.isArray(tail.content) || tail.content.length === 0) return false;
  return tail.content.some(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const block = part as Record<string, unknown>;
    return ((block.type === "input_text" || block.type === "text")
        && typeof block.text === "string" && block.text.trim().length > 0)
      || block.type === "input_image";
  });
}

/** Media tools are available only from structural genuine-current-human provenance. */
export function deriveCurrentUserVideoIntent(rawBody: unknown): CurrentUserVideoIntent {
  return { state: hasGenuineCurrentUserTail(rawBody) ? "eligible" : "none" };
}
