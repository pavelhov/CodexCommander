import type { CodexCommanderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import {
  DecompressedBodyTooLargeError,
  readBoundedJsonRequestBody,
} from "../request-decompress";

export const MANAGEMENT_JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;

export function readManagementJsonBody<T = unknown>(req: Request): Promise<T> {
  return readBoundedJsonRequestBody(req, MANAGEMENT_JSON_BODY_MAX_BYTES) as Promise<T>;
}

/** Read a management body exactly as received, without imposing JSON semantics. */
export async function readManagementRawBody(req: Request): Promise<Uint8Array> {
  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MANAGEMENT_JSON_BODY_MAX_BYTES) {
    throw new DecompressedBodyTooLargeError(declaredLength, MANAGEMENT_JSON_BODY_MAX_BYTES);
  }
  if (req.body === null) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > MANAGEMENT_JSON_BODY_MAX_BYTES) {
        throw new DecompressedBodyTooLargeError(length, MANAGEMENT_JSON_BODY_MAX_BYTES);
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* the original body error wins */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function managementBodyTooLargeResponse(
  error: unknown,
  req: Request,
  config: CodexCommanderConfig,
): Response | null {
  return error instanceof DecompressedBodyTooLargeError
    ? jsonResponse({ error: "request body too large" }, 413, req, config)
    : null;
}

export function rethrowManagementBodyTooLarge(error: unknown): void {
  if (error instanceof DecompressedBodyTooLargeError) throw error;
}

export async function readManagementJsonBodyOr<T>(req: Request, fallback: T): Promise<unknown | T> {
  try {
    return await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return fallback;
  }
}
