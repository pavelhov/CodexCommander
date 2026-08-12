import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { CodexCommanderConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as CodexCommanderConfig;

async function routeStatus(
  deps: ManagementApiDeps,
  method = "GET",
): Promise<Response | null> {
  const url = new URL("http://127.0.0.1:10100/api/codex-routing");
  return handleManagementAPI(new Request(url, { method }), url, config, deps);
}

describe("GET /api/codex-routing", () => {
  test("returns a strict, secret-free, uncached DTO from one route observation", async () => {
    let calls = 0;
    const response = await routeStatus({
      getCodexRoutingKind: () => {
        calls += 1;
        return "codexcommander-local";
      },
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(calls).toBe(1);
    expect(await response!.json()).toEqual({
      schemaVersion: 1,
      routingKind: "codexcommander-local",
      routingInjected: true,
    });
  });

  test("derives ownership from the same observation for every routing kind", async () => {
    for (const routingKind of [
      "native",
      "custom-local",
      "custom-remote",
      "unknown",
    ] as const) {
      const response = await routeStatus({ getCodexRoutingKind: () => routingKind });
      expect(await response!.json()).toEqual({
        schemaVersion: 1,
        routingKind,
        routingInjected: false,
      });
    }
  });

  test("is exact-GET only", async () => {
    expect(await routeStatus({ getCodexRoutingKind: () => "native" }, "POST")).toBeNull();
    const slash = new URL("http://127.0.0.1:10100/api/codex-routing/");
    expect(await handleManagementAPI(
      new Request(slash),
      slash,
      config,
      { getCodexRoutingKind: () => "native" },
    )).toBeNull();
  });
});
