export type CurrentUserVideoIntentState = "none" | "confirmation_required" | "explicit";

export interface CurrentUserVideoIntent {
  state: CurrentUserVideoIntentState;
}

function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap(part => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const item = part as Record<string, unknown>;
      return (item.type === "input_text" || item.type === "text") && typeof item.text === "string"
        ? [item.text]
        : [];
    })
    .join("\n");
}

/** Return only text authored by the current user at the tail of this request. */
export function currentUserAuthoredText(rawBody: unknown): string | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return undefined;
  const input = (rawBody as { input?: unknown }).input;
  if (typeof input === "string") return input.trim() || undefined;
  if (!Array.isArray(input) || input.length === 0) return undefined;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const value = input[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (item.type === "additional_tools") continue;
    if (item.type !== "message" || item.role !== "user") return undefined;
    const text = inputText(item.content).trim();
    return text || undefined;
  }
  return undefined;
}

function hasImageToVideoIntent(text: string): boolean {
  return /\b(?:animate|turn|convert)\b[\s\S]{0,80}\b(?:image|photo|picture|frame)\b/i.test(text)
    || /\b(?:image|photo|picture|frame)\s*[- ]to[- ]video\b/i.test(text)
    || /\bvideo\b[\s\S]{0,50}\b(?:from|using|based\s+on)\b[\s\S]{0,50}\b(?:image|photo|picture|frame)\b/i.test(text);
}

/** Conservative, wording-only admission signal for v1 text-to-video. */
export function deriveCurrentUserVideoIntent(rawBody: unknown): CurrentUserVideoIntent {
  const currentUserText = currentUserAuthoredText(rawBody);
  if (!currentUserText) return { state: "none" };

  const mentionsVideo = /\b(?:video|videos|clip|clips|animation|movie|text\s*[- ]to[- ]video)\b/i.test(currentUserText);
  if (!mentionsVideo) return { state: "none" };
  if (hasImageToVideoIntent(currentUserText)) {
    return { state: "confirmation_required" };
  }

  const explicitGeneration = /\b(?:create|generate|make|produce|render|synthesize)\b[\s\S]{0,100}\b(?:video|videos|clip|clips|animation|movie)\b/i.test(currentUserText)
    || /\btext\s*[- ]to[- ]video\b/i.test(currentUserText);
  return { state: explicitGeneration ? "explicit" : "confirmation_required" };
}
