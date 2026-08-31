import { createHmac, timingSafeEqual } from "node:crypto";

import { isLocalAttestationSecret } from "./local-management-attestation";

export const MEDIA_ACTION_ATTESTATION_HEADER = "x-codexcommander-media-action-proof";
export const MEDIA_ACTION_NONCE = /^[A-Za-z0-9_-]{43}$/;
export const MEDIA_ACTION_ATTESTATION_MAX_AGE_MS = 5 * 60_000;
const MEDIA_ACTION_ATTESTATION_MAX_FUTURE_SKEW_MS = 30_000;

export interface MediaActionAttestationInput {
  action: "probe" | "acknowledge" | "open" | "reveal" | "quarantine_reset" | "settings"
    | "xai_key_add" | "xai_key_select" | "xai_key_remove" | "xai_key_alias";
  target?: "job" | "probe" | "recovery" | "settings" | "xai_key";
  id: string;
  expectedRevision: number;
  confirmation: true;
  caller: "interactive_cli";
  step?: "image" | "video";
  imagesEnabled?: boolean;
  videosEnabled?: boolean;
  authSource?: "subscription_oauth" | "api_key";
  name?: "xai";
  key?: string;
  label?: string;
  alias?: string;
  nonce: string;
  issuedAt: number;
}

function payload(input: MediaActionAttestationInput, pid: number, port: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (!MEDIA_ACTION_NONCE.test(input.nonce)) return null;
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt <= 0) return null;
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return null;
  if (input.confirmation !== true || input.caller !== "interactive_cli") return null;
  return JSON.stringify([
    "codexcommander-media-action-v1",
    pid,
    port,
    input.action,
    input.target ?? null,
    input.id,
    input.expectedRevision,
    input.confirmation,
    input.caller,
    input.step ?? null,
    input.imagesEnabled ?? null,
    input.videosEnabled ?? null,
    input.authSource ?? null,
    input.name ?? null,
    input.key ?? null,
    input.label ?? null,
    input.alias ?? null,
    input.nonce,
    input.issuedAt,
  ]);
}

export function createMediaActionAttestationProof(
  secret: string,
  input: MediaActionAttestationInput,
  pid: number,
  port: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const canonical = payload(input, pid, port);
  return canonical ? createHmac("sha256", secret).update(canonical).digest("base64url") : null;
}

export function verifyMediaActionAttestationProof(
  secret: string,
  input: MediaActionAttestationInput,
  pid: number,
  port: number,
  proof: string | null,
  now = Date.now(),
): boolean {
  if (
    !Number.isSafeInteger(now)
    || input.issuedAt < now - MEDIA_ACTION_ATTESTATION_MAX_AGE_MS
    || input.issuedAt > now + MEDIA_ACTION_ATTESTATION_MAX_FUTURE_SKEW_MS
  ) return false;
  const expected = createMediaActionAttestationProof(secret, input, pid, port);
  if (!expected || !proof || !MEDIA_ACTION_NONCE.test(proof)) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(proof);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
