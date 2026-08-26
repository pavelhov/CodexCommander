import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export function isLocalAttestationSecret(value: unknown): value is string {
  return typeof value === "string" && BASE64URL_256.test(value);
}

export function createLocalAttestationSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createLocalAttestationChallenge(): string {
  return randomBytes(32).toString("base64url");
}

function attestationPayload(challenge: string, pid: number, port: number): string | null {
  if (!BASE64URL_256.test(challenge)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `codexcommander-local-management-v1\n${challenge}\n${pid}\n${port}`;
}

function metadataAttestationPayload(
  challenge: string,
  pid: number,
  port: number,
  version: string,
  generation: number,
  lifecycleLease: boolean,
): string | null {
  const base = attestationPayload(challenge, pid, port);
  if (!base || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    || !Number.isSafeInteger(generation) || generation < 0) return null;
  return `codexcommander-local-management-v2\n${challenge}\n${pid}\n${port}\n${version}\n${generation}\n${lifecycleLease ? "1" : "0"}`;
}

export function createLocalAttestationProof(
  secret: string,
  challenge: string,
  pid: number,
  port: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = attestationPayload(challenge, pid, port);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyLocalAttestationProof(
  secret: string,
  challenge: string,
  pid: number,
  port: number,
  proof: string | null,
): boolean {
  const expected = createLocalAttestationProof(secret, challenge, pid, port);
  if (!expected || !proof || !BASE64URL_256.test(proof)) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(proof);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function createLocalAttestationMetadataProof(
  secret: string,
  challenge: string,
  pid: number,
  port: number,
  version: string,
  generation: number,
  lifecycleLease: boolean,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = metadataAttestationPayload(challenge, pid, port, version, generation, lifecycleLease);
  return payload ? createHmac("sha256", secret).update(payload).digest("base64url") : null;
}

export function verifyLocalAttestationMetadataProof(
  secret: string,
  challenge: string,
  pid: number,
  port: number,
  version: string,
  generation: number,
  lifecycleLease: boolean,
  proof: string | null,
): boolean {
  const expected = createLocalAttestationMetadataProof(secret, challenge, pid, port, version, generation, lifecycleLease);
  if (!expected || !proof || !BASE64URL_256.test(proof)) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(proof);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
