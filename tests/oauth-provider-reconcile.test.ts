import { describe, expect, test } from "bun:test";
import { OAUTH_PROVIDERS, upsertOAuthProvider } from "../src/oauth";
import type { CodexCommanderConfig } from "../src/types";

describe("OAuth provider upsert", () => {
  test("preserves an explicit Antigravity liveModels override during re-login", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          liveModels: true,
        },
      },
    } satisfies CodexCommanderConfig;

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
    expect(config.providers["google-antigravity"].models).toHaveLength(6);
  });

  test("preserves Antigravity liveModels during re-login", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          liveModels: true,
        },
      },
    } satisfies CodexCommanderConfig;

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);

    config.providers["google-antigravity"].liveModels = true;
    config.providers["google-antigravity"].authMode = "key";
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);

    config.providers["google-antigravity"].authMode = undefined;
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
  });
});
