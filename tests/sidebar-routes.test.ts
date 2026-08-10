import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { CodexCommanderConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as CodexCommanderConfig;

async function call(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  principal?: "admin-token" | "gui-session",
): Promise<{ status: number; body: unknown; raw: string; routed: boolean }> {
  // `isAllowedManagementOrigin` derives the expected origin from the Host header and
  // rejects the request outright when it is missing, so Host is required here. Omitting
  // Origin models the GUI's own same-origin fetch.
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1:10100", ...headers } });
  const res = await handleManagementAPI(req, url, config, {}, principal);
  if (!res) return { status: 404, body: null, raw: "", routed: false };
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, raw, routed: true };
}

describe("removed updater API", () => {
  test("check, run, status, and badge endpoints are all unrouted", async () => {
    for (const [method, path] of [
      ["GET", "/api/update/check"],
      ["POST", "/api/update/run"],
      ["GET", "/api/update/status?jobId=missing"],
      ["GET", "/api/update/badge"],
    ] as const) {
      const result = await call(method, path);
      expect(result).toEqual({ status: 404, body: null, raw: "", routed: false });
    }
  });

  test("management dispatch contains no updater or sidebar handler", async () => {
    const managementApi = await Bun.file(new URL("../src/server/management-api.ts", import.meta.url)).text();
    const configRoutes = await Bun.file(new URL("../src/server/management/config-routes.ts", import.meta.url)).text();
    expect(managementApi).not.toContain("handleSidebarRoutes");
    expect(configRoutes).not.toContain("/api/update/");
    expect(configRoutes).not.toContain('import("../../update/');
    expect(await Bun.file(new URL("../src/server/management/sidebar-routes.ts", import.meta.url)).exists()).toBe(false);
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

});
