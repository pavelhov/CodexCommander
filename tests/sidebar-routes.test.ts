import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

/**
 * Route-level proof for the sidebar update-badge endpoint. Badge state is
 * cosmetic and must stay scalar-only: no npm/registry output, paths, or tokens.
 */
const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

async function call(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; raw: string; routed: boolean }> {
  // `isAllowedManagementOrigin` derives the expected origin from the Host header and
  // rejects the request outright when it is missing, so Host is required here. Omitting
  // Origin models the GUI's own same-origin fetch.
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1:10100", ...headers } });
  const res = await handleManagementAPI(req, url, config);
  if (!res) return { status: 404, body: null, raw: "", routed: false };
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, raw, routed: true };
}

describe("GET /api/update/badge", () => {
  test("is routed and reports scalar badge fields", async () => {
    const { status, body } = await call("GET", "/api/update/badge");
    expect(status).toBe(200);
    const badge = body as Record<string, unknown>;
    expect(typeof badge.updateAvailable).toBe("boolean");
    expect(typeof badge.canUpdate).toBe("boolean");
    expect(typeof badge.unknown).toBe("boolean");
    expect(["latest", "preview"]).toContain(badge.channel);
  });

  test("serializes scalars only — no paths, commands, or registry output", async () => {
    const { raw } = await call("GET", "/api/update/badge");
    expect(raw).not.toContain("npm");
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("node_modules");
  });
});

describe("route surface", () => {
  test("the star API is gone", async () => {
    for (const method of ["GET", "POST"] as const) {
      const res = await call(method, "/api/github/star");
      expect(res.routed).toBe(false);
      expect(res.status).toBe(404);
    }
  });

  test("an unknown method never reaches the badge reader", async () => {
    const { status, raw } = await call("DELETE", "/api/update/badge");
    // Whatever the dispatcher decides (405/404), it must not answer with badge data.
    expect(status).not.toBe(200);
    expect(raw).not.toContain("updateAvailable");
  });

  test("the badge route sits behind the cross-origin gate", async () => {
    const blocked = await call("GET", "/api/update/badge", { origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    expect(blocked.raw).not.toContain("updateAvailable");
  });
});
