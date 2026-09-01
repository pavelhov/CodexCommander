import type { AuthorizedMediaInput, MediaInputMimeType } from "./media-input-snapshot";

const INLINE_IMAGE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

export interface MediaInputHandleDescription {
  readonly handle: string;
  readonly ordinal: number;
}

/** Private, immutable request-local mapping. Only labels are suitable for model context. */
export class MediaInputHandleTable {
  readonly #inputs: ReadonlyMap<string, AuthorizedMediaInput>;
  readonly descriptions: readonly MediaInputHandleDescription[];

  constructor(entries: readonly AuthorizedMediaInput[]) {
    const mapped = new Map<string, AuthorizedMediaInput>();
    const descriptions: MediaInputHandleDescription[] = [];
    entries.forEach((entry, index) => {
      const handle = `current_user_image_${index + 1}`;
      mapped.set(handle, Object.freeze({ bytes: entry.bytes.slice(), mimeType: entry.mimeType }));
      descriptions.push(Object.freeze({ handle, ordinal: index + 1 }));
    });
    this.#inputs = mapped;
    this.descriptions = Object.freeze(descriptions);
  }

  resolve(handle: string): AuthorizedMediaInput | undefined {
    const value = this.#inputs.get(handle);
    return value ? { bytes: value.bytes.slice(), mimeType: value.mimeType } : undefined;
  }
}

function currentUserContent(rawBody: unknown): unknown[] | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return undefined;
  const input = (rawBody as { input?: unknown }).input;
  if (!Array.isArray(input) || input.length === 0) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const value = input[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (item.type === "additional_tools") continue;
    const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
    if (effectiveType !== "message" || item.role !== "user" || !Array.isArray(item.content)) return undefined;
    return item.content;
  }
  return undefined;
}

function decodeInlineImage(value: unknown): AuthorizedMediaInput | undefined {
  if (typeof value !== "string") return undefined;
  const match = INLINE_IMAGE.exec(value);
  if (!match) return undefined;
  try {
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.byteLength === 0) return undefined;
    return { bytes: new Uint8Array(bytes), mimeType: match[1] as MediaInputMimeType };
  } catch {
    return undefined;
  }
}

/**
 * Extract only inline images on the genuine current-user tail. Historical, tool, assistant,
 * file_id, remote URL, malformed, and replay-only parts never enter the table.
 */
export function buildMediaInputHandleTable(rawBody: unknown): MediaInputHandleTable {
  const entries: AuthorizedMediaInput[] = [];
  for (const part of currentUserContent(rawBody) ?? []) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    if (item.type !== "input_image" || Object.hasOwn(item, "file_id")) continue;
    const input = decodeInlineImage(item.image_url);
    if (input) entries.push(input);
  }
  return new MediaInputHandleTable(entries);
}
