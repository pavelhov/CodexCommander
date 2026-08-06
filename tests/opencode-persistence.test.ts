import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpencodeProviderBlock } from "../src/clients/config-export";
import {
  applyOpencodeIntegration,
  inspectOpencodeIntegration,
  opencodeFileReference,
  opencodeIntegrationPaths,
  restoreOpencodeIntegration,
  setOpencodeAutoConnect,
} from "../src/clients/opencode-persistence";
import type { OcxConfig } from "../src/types";

const TOKEN = "test-proxy-admission-token-never-serialize";

function providerBlock(): OpencodeProviderBlock {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "OpenCodex",
    options: {
      baseURL: "http://127.0.0.1:10100/v1",
      apiKey: "{env:OPENCODEX_OPENCODE_API_KEY}",
    },
    models: {
      "opencode-go/gpt-5.6-luna": {
        name: "GPT-5.6 Luna (opencode-go)",
        limit: { context: 1_000_000, output: 32_000 },
      },
    },
  };
}

function config(hostname = "127.0.0.1"): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        authMode: "key",
      },
    },
  } as OcxConfig;
}

describe("durable OpenCode integration", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-opencode-persist-"));
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(root, ".opencodex");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  function paths() {
    return opencodeIntegrationPaths({}, root, join(root, ".opencodex"));
  }

  function writeConfig(path: string, text: string, mode = 0o640): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
  }

  test("file references reject syntax-breaking paths", () => {
    expect(() => opencodeFileReference(join(root, "bad}path"))).toThrow(/unsupported characters/);
    expect(() => opencodeFileReference(join(root, "bad\npath"))).toThrow(/unsupported characters/);
  });

  test("applies only provider.opencodex, preserves JSONC, and keeps the token out of config and journal", () => {
    const p = paths();
    const original = `{
  // keep this user's MCP and theme settings
  "theme": "system",
  "provider": {
    "other": { "npm": "example" },
  },
}
`;
    writeConfig(p.configJsonPath, original);

    const result = applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    const applied = readFileSync(p.configJsonPath, "utf8");
    const journal = readFileSync(p.journalPath, "utf8");

    expect(result.status.state).toBe("applied");
    expect(applied).toContain("keep this user's MCP and theme settings");
    expect(applied).toContain('"other": {');
    expect(applied).toContain('"npm": "example"');
    expect(applied).toContain(`{file:${p.tokenPath}}`);
    expect(applied).not.toContain(TOKEN);
    expect(journal).not.toContain(TOKEN);
    expect(readFileSync(p.tokenPath, "utf8")).toBe(TOKEN);
    if (process.platform !== "win32") expect(lstatSync(p.tokenPath).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(lstatSync(p.configJsonPath).mode & 0o777).toBe(0o640);
  });

  test("targets opencode.jsonc when both global files exist", () => {
    const p = paths();
    writeConfig(p.configJsonPath, '{"theme":"json"}\n');
    writeConfig(p.configJsoncPath, '{\n  // winning layer\n  "theme": "jsonc"\n}\n');

    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });

    expect(readFileSync(p.configJsonPath, "utf8")).toBe('{"theme":"json"}\n');
    expect(readFileSync(p.configJsoncPath, "utf8")).toContain('"opencodex"');
    expect(inspectOpencodeIntegration(p).targetPath).toBe(p.configJsoncPath);
  });

  test("refuses malformed JSONC without changing bytes", () => {
    const p = paths();
    const malformed = '{ "provider": { // missing close\n';
    writeConfig(p.configJsonPath, malformed);

    expect(() => applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() }))
      .toThrow(/malformed JSONC/);
    expect(readFileSync(p.configJsonPath, "utf8")).toBe(malformed);
    expect(inspectOpencodeIntegration(p).state).toBe("not_applied");
  });

  test("exact restore returns an unchanged target byte-for-byte", () => {
    const p = paths();
    const original = '{\r\n\t// original bytes\r\n\t"theme": "dark",\r\n}\r\n';
    writeConfig(p.configJsonPath, original);
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });

    const restored = restoreOpencodeIntegration({ paths: p });

    expect(restored.restored).toBe(true);
    expect(restored.exact).toBe(true);
    expect(restored.preservedUserEdits).toBe(false);
    expect(readFileSync(p.configJsonPath, "utf8")).toBe(original);
    expect(restored.status.state).toBe("not_applied");
  });

  test("recognizes an externally restored original as safe exact cleanup", () => {
    const p = paths();
    const original = '{"theme":"original"}\n';
    writeConfig(p.configJsonPath, original);
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    writeFileSync(p.configJsonPath, original);

    const restored = restoreOpencodeIntegration({ paths: p });

    expect(restored.exact).toBe(true);
    expect(readFileSync(p.configJsonPath, "utf8")).toBe(original);
    expect(restored.status.state).toBe("not_applied");
  });

  test("surgical restore preserves later user edits and removes only the managed provider", () => {
    const p = paths();
    writeConfig(p.configJsonPath, '{\n  "theme": "light"\n}\n');
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    const userEdited = readFileSync(p.configJsonPath, "utf8").replace(
      '"theme": "light"',
      '"theme": "dark",\n  "username": "kept"',
    );
    writeFileSync(p.configJsonPath, userEdited);

    const restored = restoreOpencodeIntegration({ paths: p });
    const final = readFileSync(p.configJsonPath, "utf8");

    expect(restored.exact).toBe(false);
    expect(restored.preservedUserEdits).toBe(true);
    expect(final).toContain('"theme": "dark"');
    expect(final).toContain('"username": "kept"');
    expect(final).not.toContain('"opencodex"');
    expect(final).not.toContain('"provider"');
  });

  test("re-apply never makes later user edits eligible for destructive exact restore", () => {
    const p = paths();
    writeConfig(p.configJsonPath, '{\n  "theme": "light"\n}\n');
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    writeFileSync(p.configJsonPath, readFileSync(p.configJsonPath, "utf8").replace(
      '"theme": "light"',
      '"theme": "dark",\n  "username": "kept-after-refresh"',
    ));

    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config(), autoConnect: true });
    const restored = restoreOpencodeIntegration({ paths: p });
    const final = readFileSync(p.configJsonPath, "utf8");

    expect(restored.exact).toBe(false);
    expect(restored.preservedUserEdits).toBe(true);
    expect(final).toContain('"theme": "dark"');
    expect(final).toContain('"username": "kept-after-refresh"');
    expect(final).not.toContain('"opencodex"');
  });

  test("surgical restore reinstates a pre-existing provider value", () => {
    const p = paths();
    writeConfig(p.configJsonPath, '{\n  "provider": {\n    "opencodex": { "name": "user-owned" }\n  }\n}\n');
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    writeFileSync(p.configJsonPath, readFileSync(p.configJsonPath, "utf8").replace("{\n", '{\n  "theme": "later",\n'));

    restoreOpencodeIntegration({ paths: p });
    const final = readFileSync(p.configJsonPath, "utf8");
    expect(final).toContain('"name": "user-owned"');
    expect(final).toContain('"theme": "later"');
  });

  test("full restore of a changed file requires its current hash confirmation", () => {
    const p = paths();
    writeConfig(p.configJsonPath, '{"theme":"light"}\n');
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    writeFileSync(p.configJsonPath, readFileSync(p.configJsonPath, "utf8").replace("light", "dark"));

    expect(() => restoreOpencodeIntegration({ paths: p, mode: "full" }))
      .toThrow(/requires confirmation/);
  });

  test("refuses to refresh when the protected backup was tampered with", () => {
    const p = paths();
    writeConfig(p.configJsonPath, '{"theme":"light"}\n');
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    const journal = JSON.parse(readFileSync(p.journalPath, "utf8")) as { backupPath: string };
    writeFileSync(journal.backupPath, "tampered\n");
    const before = readFileSync(p.configJsonPath, "utf8");

    expect(() => applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() }))
      .toThrow(/backup integrity/);
    expect(readFileSync(p.configJsonPath, "utf8")).toBe(before);
    expect(inspectOpencodeIntegration(p).state).toBe("needs_attention");
  });

  test("fails closed when the protected token becomes group- or world-readable", () => {
    if (process.platform === "win32") return;
    const p = paths();
    writeConfig(p.configJsonPath, '{"theme":"light"}\n');
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    chmodSync(p.tokenPath, 0o644);

    const status = inspectOpencodeIntegration(p);
    expect(status.state).toBe("needs_attention");
    expect(status.tokenReady).toBe(false);
    expect(status.detail).toMatch(/credential reference.*unsafe/i);
  });

  test("refuses an integration state directory symlink before writing credentials", () => {
    if (process.platform === "win32") return;
    const p = paths();
    const outside = join(root, "redirected-state");
    mkdirSync(outside, { recursive: true });
    mkdirSync(dirname(p.stateDir), { recursive: true });
    symlinkSync(outside, p.stateDir);
    writeConfig(p.configJsonPath, '{"theme":"light"}\n');

    expect(() => applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() }))
      .toThrow(/safe directory/);
    expect(readFileSync(p.configJsonPath, "utf8")).toBe('{"theme":"light"}\n');
    expect(existsSync(join(outside, "proxy-api-key"))).toBe(false);
  });

  test("auto-connect is explicit and persisted only after apply", () => {
    const p = paths();
    expect(() => setOpencodeAutoConnect(true, p)).toThrow(/Apply the OpenCode integration/);
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config() });
    expect(setOpencodeAutoConnect(true, p).autoConnect).toBe(true);
    expect(inspectOpencodeIntegration(p).autoConnect).toBe(true);
  });

  test("non-loopback configuration uses the dedicated admission header file reference", () => {
    const p = paths();
    applyOpencodeIntegration(providerBlock(), TOKEN, { paths: p, config: config("0.0.0.0") });
    const applied = readFileSync(p.configJsonPath, "utf8");
    expect(applied).toContain('"x-opencodex-api-key"');
    expect(applied).toContain(`{file:${p.tokenPath}}`);
    expect(applied).not.toContain('"apiKey"');
  });
});
