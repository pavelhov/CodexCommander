import { describe, expect, test } from "bun:test";
import {
  applyEol,
  buildOpenaiBaseUrlLine,
  buildProfileFile,
  buildProviderTableBlock,
  chooseCatalogPathForInjection,
  dominantEol,
  externalCodexModelProvider,
  setRootOpenaiBaseUrl,
  stripMarkerOwnedRoutingForNativeEscape,
  stripInjectedOpenaiBaseUrl,
  stripCodexCommanderConfig,
  stripRootContextWindowOverrides,
} from "../src/codex/inject";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../src/codex/subagent-defaults";

describe("Codex config injection", () => {
  test("external provider detection uses parsed TOML structure", () => {
    expect(externalCodexModelProvider([
      'note = """',
      'model_provider = "decoy"',
      '"""',
      "",
    ].join("\n"))).toBeNull();
    expect(externalCodexModelProvider([
      'profile = "work"',
      'model_provider = "root-provider"',
      "[profiles.work]",
      'model_provider = "profile-provider"',
      "",
    ].join("\n"))).toBe("profile-provider");
  });

  test("omits provider-level Responses WebSocket support by default", () => {
    const block = buildProviderTableBlock(10100);

    expect(block).toContain("[model_providers.codexcommander]");
    expect(block).toContain('wire_api = "responses"');
    expect(block).toContain("requires_openai_auth = true");
    expect(block).not.toContain("supports_websockets");
  });

  test("can suppress provider-level Responses WebSocket support for explicit opt-out", () => {
    const block = buildProviderTableBlock(10100, false);

    expect(block).not.toContain("supports_websockets");
  });

  test("can advertise provider-level Responses WebSocket support for explicit opt-in", () => {
    const block = buildProviderTableBlock(10100, true);

    expect(block).toContain("supports_websockets = true");
  });

  test("can inject Codex provider API auth header from environment for non-loopback proxy mode", () => {
    const block = buildProviderTableBlock(10100, false, true);

    expect(block).toContain('env_http_headers = { "x-codexcommander-api-key" = "CODEXCOMMANDER_API_AUTH_TOKEN" }');
  });

  test("injected base_url matches the actual bind: literal 127.0.0.1 for loopback/wildcard (Windows resolves localhost to ::1 first)", () => {
    expect(buildProviderTableBlock(10100, false, false, undefined)).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "localhost")).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "0.0.0.0")).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "::")).toContain('base_url = "http://127.0.0.1:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "::1")).toContain('base_url = "http://[::1]:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "[::1]")).toContain('base_url = "http://[::1]:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "192.168.1.20")).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "2001:db8::5")).toContain('base_url = "http://[2001:db8::5]:10100/v1"');
    expect(buildProviderTableBlock(10100, false, false, "localhost.")).toContain('base_url = "http://localhost.:10100/v1"');
  });

  test("strips stale root context-window overrides on injection so the catalog drives model context (gpt-5.5 regression)", () => {
    const cleaned = stripRootContextWindowOverrides([
      'model_provider = "codexcommander"',
      "model_context_window = 1000000",
      "model_auto_compact_token_limit = 900000",
      'model_auto_compact_token_limit_scope = "total"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.codexcommander]",
      "# a nested table key must survive",
      "model_context_window = 272000",
      "",
    ].join("\n"));

    // Only the stale root context-window override is removed. Compaction is a user-owned limit.
    expect(cleaned).not.toMatch(/^model_context_window = 1000000$/m);
    expect(cleaned).toContain("model_auto_compact_token_limit = 900000");
    expect(cleaned).toContain('model_auto_compact_token_limit_scope = "total"');
    // Non-context-window root keys are untouched.
    expect(cleaned).toContain('model_provider = "codexcommander"');
    expect(cleaned).toContain('model = "gpt-5.5"');
    // Table-nested keys (after the first [table]) are preserved.
    expect(cleaned).toContain("model_context_window = 272000");
  });

  test("preserves user root context-window overrides when restoring native Codex", () => {
    const stripped = stripCodexCommanderConfig([
      'model = "gpt-5.5"',
      'model_context_window = 1000000',
      'model_auto_compact_token_limit = 900000',
      'model_catalog_json = "/tmp/codexcommander-catalog.json"',
      'model_provider = "codexcommander"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain("model_context_window = 1000000");
    expect(stripped).toContain("model_auto_compact_token_limit = 900000");
    expect(stripped).not.toContain("model_provider");
    expect(stripped).not.toContain("model_catalog_json");
  });

  test("removes root routed model names when restoring native Codex", () => {
    const stripped = stripCodexCommanderConfig([
      'model_provider = "codexcommander"',
      'model = "opencode-go/minimax-m3"',
      'model_verbosity = "high"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));

    expect(stripped).not.toContain('model = "opencode-go/minimax-m3"');
    expect(stripped).toContain('model_verbosity = "high"');
  });

  test("preserves non-codexcommander routed model names during fallback restore", () => {
    const stripped = stripCodexCommanderConfig([
      'model_provider = "proxy"',
      'model = "openrouter/foo"',
      "",
      "[model_providers.proxy]",
      'name = "Existing Proxy"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));

    expect(stripped).toContain('model_provider = "proxy"');
    expect(stripped).toContain('model = "openrouter/foo"');
    expect(stripped).toContain("[model_providers.proxy]");
  });

  test("loopback fallback file uses the Design B root override (no provider table)", () => {
    const profile = buildProfileFile(10100, null);

    expect(profile).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(profile).not.toContain('model_provider = "codexcommander"');
    expect(profile).not.toContain("[model_providers.codexcommander]");
    expect(profile).not.toContain("model_catalog_json");
  });

  test("fallback profile does not force fast_mode when fastMode is unset", () => {
    expect(buildProfileFile(10100, null)).not.toContain("fast_mode");
    expect(buildProfileFile(10100, null, false, true, "192.168.1.20")).not.toContain("fast_mode");
  });

  test("fallback profile mirrors an explicit fastMode=true override", () => {
    const loopback = buildProfileFile(10100, null, false, false, undefined, true);

    expect(loopback).toContain("fast_mode = true");
    expect(loopback).not.toContain("fast_mode = false");
  });

  test("fallback profile mirrors an explicit fastMode=false override", () => {
    const loopback = buildProfileFile(10100, null, false, false, undefined, false);

    expect(loopback).toContain("fast_mode = false");
    expect(loopback).not.toContain("fast_mode = true");

    const providerTable = buildProfileFile(10100, null, false, true, "192.168.1.20", false);
    expect(providerTable).toContain("fast_mode = false");
    expect(providerTable).not.toContain("fast_mode = true");
  });

  test("non-loopback fallback profile keeps the provider-table shape with the injected host", () => {
    const profile = buildProfileFile(10100, null, false, true, "192.168.1.20");

    expect(profile).toContain("proxy at 192.168.1.20:10100");
    expect(profile).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(profile).toContain('model_provider = "codexcommander"');
    expect(profile).toContain("[model_providers.codexcommander]");
  });

  test("non-loopback fallback profile mirrors websocket and API auth provider options", () => {
    const profile = buildProfileFile(10100, "/tmp/codexcommander-catalog.json", true, true);

    expect(profile).toContain('model_catalog_json = "/tmp/codexcommander-catalog.json"');
    expect(profile).toContain("supports_websockets = true");
    expect(profile).toContain('env_http_headers = { "x-codexcommander-api-key" = "CODEXCOMMANDER_API_AUTH_TOKEN" }');
  });

  test("honors an explicit unavailable catalog decision", () => {
    const path = chooseCatalogPathForInjection('model_catalog_json = "/tmp/codexcommander-catalog.json"\n', null);

    expect(path).toBeNull();
  });

  test("strips injected TOML sections without swallowing later indented tables", () => {
    const stripped = stripCodexCommanderConfig([
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      " [model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://localhost:10100/v1"',
      " [plugins.safe]",
      "enabled = true",
      "",
      " [profiles.codexcommander]",
      'model_provider = "codexcommander"',
      " [profiles.work]",
      'model = "gpt-5.5"',
      "",
    ].join("\n"));

    expect(stripped).toContain("[plugins.safe]");
    expect(stripped).toContain("enabled = true");
    expect(stripped).toContain("[profiles.work]");
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).not.toContain("[model_providers.codexcommander]");
    expect(stripped).not.toContain("[profiles.codexcommander]");
  });

  test("strip removes only marker-owned native subagent defaults", () => {
    const stripped = stripCodexCommanderConfig([
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "gpt-5.6-sol"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "high"',
      "max_threads = 8",
      "",
    ].join("\n"));

    expect(stripped).toContain("[agents]");
    expect(stripped).toContain("max_threads = 8");
    expect(stripped).not.toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(stripped).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(stripped).not.toContain("default_subagent_model");
    expect(stripped).not.toContain("default_subagent_reasoning_effort");
  });
});

describe("Design B openai_base_url injection", () => {
  test("native escape removes only the marker-owned endpoint and CCX catalog bytes", () => {
    const fixtures = [
      {
        name: "LF with final newline",
        eol: "\n",
        prefix: "",
        final: "\n",
      },
      {
        name: "CRLF with BOM and no final newline",
        eol: "\r\n",
        prefix: "\uFEFF",
        final: "",
      },
    ];
    for (const fixture of fixtures) {
      const before = fixture.prefix + [
        '# untouched = "exact bytes"',
        'model_catalog_json = "/tmp/codexcommander-catalog.json"',
        "# Auto-injected by CodexCommander",
        'openai_base_url = "http://127.0.0.1:10100/v1"',
        "",
        "[features]",
        "fast_mode = true",
      ].join(fixture.eol) + fixture.final;
      const expected = fixture.prefix + [
        '# untouched = "exact bytes"',
        "",
        "[features]",
        "fast_mode = true",
      ].join(fixture.eol) + fixture.final;

      const escaped = stripMarkerOwnedRoutingForNativeEscape(before, "/tmp");
      expect(escaped, fixture.name).toEqual({ content: expected, changed: true });
      expect(stripMarkerOwnedRoutingForNativeEscape(escaped.content, "/tmp")).toEqual({
        content: expected,
        changed: false,
      });
    }
  });

  test("native escape preserves unmarked and near-match routing bytes", () => {
    const userOwned = [
      'model = "user/provider-model"',
      'model_catalog_json = "/tmp/user-catalog.json"',
      "# Auto-injected by CodexCommander (copied note)",
      'openai_base_url = "https://gateway.example/v1"',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(userOwned)).toEqual({
      content: userOwned,
      changed: false,
    });
  });

  test("native escape accepts the exact emitted IPv6 loopback endpoint only", () => {
    const injected = [
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://[::1]:10100/v1"',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(injected, "/tmp/codex-home")).toEqual({
      content: "",
      changed: true,
    });

    const arbitrary = injected.replace("[::1]", "192.0.2.10");
    expect(stripMarkerOwnedRoutingForNativeEscape(arbitrary, "/tmp/codex-home")).toEqual({
      content: arbitrary,
      changed: false,
    });
  });

  test("native escape removes only the canonical CODEX_HOME catalog pointer", () => {
    const before = [
      'model_catalog_json = "/tmp/elsewhere/codexcommander-catalog.json"',
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home").content).toBe(
      'model_catalog_json = "/tmp/elsewhere/codexcommander-catalog.json"\n',
    );
  });

  test("native escape supports the exact marker-owned provider-table shape", () => {
    const before = [
      'model_provider = "codexcommander"',
      'model = "provider/model"',
      'model_catalog_json = "/tmp/codex-home/codexcommander-catalog.json"',
      'model_verbosity = "high"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://192.0.2.10:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home")).toEqual({
      changed: true,
      content: [
        'model_verbosity = "high"',
        "",
        "",
        "[features]",
        "fast_mode = true",
        "",
      ].join("\n"),
    });
  });

  test("every emitted provider hostname round-trips through the native escape grammar", () => {
    for (const hostname of [
      "127.0.0.1",
      "::1",
      "localhost.",
      "host_name.local",
      "2001:db8::5",
      "fe80::1%lo0",
    ]) {
      const before = [
        'model_provider = "codexcommander"',
        "# Auto-injected by CodexCommander",
        buildProviderTableBlock(10100, false, false, hostname).trimStart()
          .replace("# Auto-injected by CodexCommander\n", ""),
      ].join("\n");
      expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home").changed).toBe(true);
    }
  });

  test("native escape preserves user comments inside an exact owned provider table", () => {
    const before = [
      'model_provider = "codexcommander"',
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      "# user note must survive",
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home")).toEqual({
      changed: true,
      content: [
        "# user note must survive",
        "",
        "[features]",
        "fast_mode = true",
        "",
      ].join("\n"),
    });
  });

  test("native escape clears a proxy-dependent slash-model after exact route proof", () => {
    const before = [
      'model = "user/provider-model"',
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home")).toEqual({
      changed: true,
      content: "",
    });
  });

  test("native escape preserves a plain native model after exact route proof", () => {
    const before = [
      'model = "gpt-5.5"',
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home")).toEqual({
      changed: true,
      content: 'model = "gpt-5.5"\n',
    });
  });

  test("native escape refuses custom provider-table keys and endpoints", () => {
    const exact = [
      'model_provider = "codexcommander"',
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n");
    for (const edited of [
      exact.replace("http://127.0.0.1:10100/v1", "https://gateway.example/v1"),
      exact.replace('wire_api = "responses"', 'wire_api = "chat"'),
      exact.replace("requires_openai_auth = true", 'organization = "user-owned"'),
      exact.replace('name = "CodexCommander Proxy"\n', ""),
    ]) {
      expect(stripMarkerOwnedRoutingForNativeEscape(edited, "/tmp/codex-home")).toEqual({
        content: edited,
        changed: false,
      });
    }
  });

  test("native escape refuses formatter variants instead of calling routed config native", () => {
    const before = [
      'model_provider = "codexcommander"',
      "# Auto-injected by CodexCommander",
      '["model_providers"."codexcommander"] # formatted',
      'base_url = "http://192.0.2.10:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home")).toEqual({
      content: before,
      changed: false,
    });
  });

  test("native escape never scans marker-looking text inside multiline TOML strings", () => {
    const before = [
      'note = """',
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      '"""',
      "",
    ].join("\n");
    expect(stripMarkerOwnedRoutingForNativeEscape(before, "/tmp/codex-home")).toEqual({
      content: before,
      changed: false,
    });
  });

  test("buildOpenaiBaseUrlLine matches the actual bind host", () => {
    expect(buildOpenaiBaseUrlLine(10100)).toBe('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(buildOpenaiBaseUrlLine(10100, "localhost")).toBe('openai_base_url = "http://127.0.0.1:10100/v1"');
    expect(buildOpenaiBaseUrlLine(10100, "::1")).toBe('openai_base_url = "http://[::1]:10100/v1"');
  });

  test("inserts marker + root key before the first table header", () => {
    const { content, keptUserBaseUrl } = setRootOpenaiBaseUrl([
      'model = "gpt-5.5"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"), 10100);

    expect(keptUserBaseUrl).toBe(false);
    const lines = content.split("\n");
    const markerIdx = lines.findIndex(l => l.includes("Auto-injected by CodexCommander"));
    const keyIdx = lines.findIndex(l => l.startsWith("openai_base_url"));
    const tableIdx = lines.findIndex(l => l.trim() === "[features]");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBe(markerIdx + 1);
    expect(keyIdx).toBeLessThan(tableIdx);
  });

  test("re-inject is idempotent and rewrites the marker-owned line on port change", () => {
    const first = setRootOpenaiBaseUrl("model = \"gpt-5.5\"\n\n[features]\nfast_mode = true\n", 10100).content;
    const second = setRootOpenaiBaseUrl(first, 10190).content;

    expect(second.match(/openai_base_url/g)?.length).toBe(1);
    expect(second.match(/Auto-injected by CodexCommander/g)?.length).toBe(1);
    expect(second).toContain('openai_base_url = "http://127.0.0.1:10190/v1"');
  });

  test("keeps a user's own root openai_base_url and injects nothing", () => {
    const original = [
      'openai_base_url = "https://my-own-gateway.example/v1"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    const { content, keptUserBaseUrl } = setRootOpenaiBaseUrl(original, 10100);

    expect(keptUserBaseUrl).toBe(true);
    expect(content).toBe(original);
  });

  test("strip removes only the marker-owned pair; a user's own line survives", () => {
    const injected = setRootOpenaiBaseUrl("model = \"gpt-5.5\"\n\n[features]\nfast_mode = true\n", 10100).content;
    const stripped = stripInjectedOpenaiBaseUrl(injected);
    expect(stripped).not.toContain("openai_base_url");
    expect(stripped).not.toContain("Auto-injected by CodexCommander");

    const userOwned = 'openai_base_url = "https://my-own-gateway.example/v1"\n\n[features]\n';
    expect(stripInjectedOpenaiBaseUrl(userOwned)).toBe(userOwned);
  });

  test("stripCodexCommanderConfig removes the Design B form including routed root models", () => {
    const injected = setRootOpenaiBaseUrl([
      'model = "opencode-go/minimax-m3"',
      'model_verbosity = "high"',
      'model_catalog_json = "/tmp/codexcommander-catalog.json"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"), 10100).content;
    const stripped = stripCodexCommanderConfig(injected);

    expect(stripped).not.toContain("openai_base_url");
    expect(stripped).not.toContain('model = "opencode-go/minimax-m3"'); // routed id useless without proxy
    expect(stripped).toContain('model_verbosity = "high"');
    expect(stripped).not.toContain("model_catalog_json");
    expect(stripped).toContain("[features]");
  });

});

describe("EOL boundary helpers (Windows CRLF configs)", () => {
  test("dominantEol picks LF for LF-only and empty content", () => {
    expect(dominantEol("")).toBe("\n");
    expect(dominantEol("a = 1\nb = 2\n")).toBe("\n");
  });

  test("dominantEol picks CRLF for CRLF-only content", () => {
    expect(dominantEol("a = 1\r\nb = 2\r\n")).toBe("\r\n");
  });

  test("dominantEol follows the majority in mixed content", () => {
    expect(dominantEol("a = 1\r\nb = 2\r\nc = 3\n")).toBe("\r\n");
    expect(dominantEol("a = 1\r\nb = 2\nc = 3\n")).toBe("\n");
  });

  test("applyEol round-trips CRLF -> LF -> CRLF without doubling CRs", () => {
    const crlf = "a = 1\r\n\r\n[t]\r\nk = 2\r\n";
    const lf = applyEol(crlf, "\n");
    expect(lf).toBe("a = 1\n\n[t]\nk = 2\n");
    expect(applyEol(lf, "\r\n")).toBe(crlf);
    // Idempotent on already-normalized input.
    expect(applyEol(crlf, "\r\n")).toBe(crlf);
  });
});
