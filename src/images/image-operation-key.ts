import { createHmac, type Hmac } from "node:crypto";

export const IMAGE_CLIENT_REQUEST_ID_MAX = 256;
const SAFE_CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._~:/+=-]*$/;

export type ImageOperationAdmissionScope =
  | { kind: "configured"; keyId: string }
  | { kind: "environment" }
  | { kind: "loopback" };

export interface ImageOperationIdentity {
  readonly operationKey: string;
  readonly requestSemanticsDigest: string;
  readonly principalDigest: string;
  readonly identityKind: "explicit" | "body_fallback";
}

export function isValidImageClientRequestId(value: string | null | undefined): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= IMAGE_CLIENT_REQUEST_ID_MAX
    && SAFE_CLIENT_REQUEST_ID.test(value);
}

function updateString(hmac: Hmac, marker: string, value: string): void {
  hmac.update(marker);
  hmac.update(String(Buffer.byteLength(value)));
  hmac.update(":");
  hmac.update(value);
}

function updateAdmission(hmac: Hmac, admission: ImageOperationAdmissionScope): void {
  updateString(hmac, "A", admission.kind);
  if (admission.kind === "configured") updateString(hmac, "I", admission.keyId);
}

type JsonFrame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; value: unknown[]; index: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number };

function updateCanonicalJson(hmac: Hmac, root: unknown): void {
  const stack: JsonFrame[] = [{ kind: "value", value: root }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        hmac.update("]");
      } else {
        stack.push({ ...frame, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.value[frame.index] });
      }
      continue;
    }
    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) {
        hmac.update("}");
      } else {
        const key = frame.keys[frame.index]!;
        updateString(hmac, "K", key);
        stack.push({ ...frame, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.value[key] });
      }
      continue;
    }
    const value = frame.value;
    if (value === null) hmac.update("N");
    else if (typeof value === "string") updateString(hmac, "S", value);
    else if (typeof value === "boolean") hmac.update(value ? "T" : "F");
    else if (typeof value === "number" && Number.isFinite(value)) updateString(hmac, "D", JSON.stringify(value));
    else if (Array.isArray(value)) {
      hmac.update(`A${value.length}[`);
      stack.push({ kind: "array", value, index: 0 });
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      hmac.update(`O${keys.length}{`);
      stack.push({ kind: "object", value: record, keys, index: 0 });
    } else {
      throw new TypeError("image operation identity requires a JSON value");
    }
  }
}

function digest(
  domain: string,
  secret: Uint8Array,
  admission: ImageOperationAdmissionScope,
  update: (hmac: Hmac) => void,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(domain);
  hmac.update("\0");
  updateAdmission(hmac, admission);
  update(hmac);
  return `hmac-sha256:${hmac.digest("hex")}`;
}

/**
 * Produce private, principal-scoped retry metadata. With no client id, exact bodies
 * intentionally share a short replay cohort; callers can always force a fresh paid
 * generation by supplying a new explicit id.
 */
export function deriveImageOperationIdentity(
  clientRequestId: string | undefined,
  secret: Uint8Array,
  admission: ImageOperationAdmissionScope,
  body: unknown,
): ImageOperationIdentity {
  const principalDigest = digest(
    "codexcommander/image-principal/v1",
    secret,
    admission,
    () => {},
  );
  const requestSemanticsDigest = digest(
    "codexcommander/image-request-body/v1",
    secret,
    admission,
    hmac => updateCanonicalJson(hmac, body),
  );
  if (clientRequestId !== undefined) {
    if (!isValidImageClientRequestId(clientRequestId)) throw new TypeError("invalid image idempotency key");
    return {
      operationKey: digest(
        "codexcommander/image-operation/v1",
        secret,
        admission,
        hmac => updateString(hmac, "R", clientRequestId),
      ),
      requestSemanticsDigest,
      principalDigest,
      identityKind: "explicit",
    };
  }
  return {
    operationKey: digest(
      "codexcommander/image-operation-body-fallback/v1",
      secret,
      admission,
      hmac => updateString(hmac, "B", requestSemanticsDigest),
    ),
    requestSemanticsDigest,
    principalDigest,
    identityKind: "body_fallback",
  };
}
