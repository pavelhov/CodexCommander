import * as readline from "node:readline";
import {
  getConfigPath,
  getDefaultConfig,
  isValidProviderName,
  mutatePersistedConfig,
  saveConfig,
  withConfigMutationLockSync,
} from "../config";
import { enrichProviderFromCatalog } from "../oauth/key-providers";
import { deriveInitProviders } from "../providers/derive";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../types";
import { dispatchRecoveryLifecycleEntrypoint } from "./lifecycle-entrypoint-dispatch";
import {
  type ProxyLifecycleResult,
  type RoutingLifecycleIo,
} from "./proxy-lifecycle";

function createPrompt(): { ask(question: string): Promise<string>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("stdin closed before the prompt could be answered"));
          return;
        }
        const onClose = () => {
          reject(new Error("stdin reached EOF while waiting for input"));
        };
        rl.once("close", onClose);
        rl.question(question, answer => {
          rl.off("close", onClose);
          resolve(answer);
        });
      });
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

type InitKind = "forward" | "oauth" | "key" | "local";
export interface InitProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  kind: InitKind;
  dashboardUrl?: string;
  defaultModel?: string;
}

/**
 * The full CLI provider menu, derived from the canonical provider registry so `ccx init`,
 * the GUI picker, key-login catalog, OAuth seeds, and metadata aliases cannot drift.
 */
export function buildInitProviders(): InitProvider[] {
  return deriveInitProviders();
}

const KIND_HEADING: Record<InitKind, string> = {
  forward: "ChatGPT login",
  oauth: "Account login (OAuth — then run: ccx login <id>)",
  key: "API key (paste a key from the provider's dashboard)",
  local: "Local servers (usually no key)",
};

function printMenu(providers: InitProvider[]): void {
  console.log("Choose your default provider (you can add more later):");
  let lastKind: InitKind | null = null;
  providers.forEach((p, i) => {
    if (p.kind !== lastKind) { console.log(`\n  ${KIND_HEADING[p.kind]}:`); lastKind = p.kind; }
    console.log(`   ${String(i + 1).padStart(2)}. ${p.label}`);
  });
  console.log(`\n   ${providers.length + 1}. custom (enter URL manually)`);
}

const envKeyFor = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

/**
 * Route Codex only through an identity-attested proxy that is already running.
 *
 * Setup deliberately does not grow its own lifecycle path: Route Back owns the
 * E -> S authority order, current-home runtime proof, durable ON transition,
 * and delegated live sync. A missing or unproven endpoint therefore cannot
 * leave Codex pointing at a dead listener.
 */
export async function routeCodexThroughLiveProxyFromInit(
  io: RoutingLifecycleIo = {},
): Promise<ProxyLifecycleResult> {
  return dispatchRecoveryLifecycleEntrypoint("route-back", { routingIo: io });
}

function replaceSetupConfigPreservingIntegrationIntent(
  current: CodexCommanderConfig,
  replacement: CodexCommanderConfig,
) {
  const integrations = current.clientIntegrations === undefined
    ? undefined
    : structuredClone(current.clientIntegrations);
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const key of Object.keys(currentRecord)) delete currentRecord[key];
  Object.assign(currentRecord, structuredClone(replacement));
  if (integrations === undefined) delete current.clientIntegrations;
  else current.clientIntegrations = integrations;
  return { changed: true, value: undefined };
}

/**
 * Replace setup-owned configuration while preserving the latest native-client
 * intent. In particular, a concurrent Stop may have persisted `codex: false`;
 * the setup wizard must not turn that back on by replacing the file with a
 * stale default object whose absent value means ON.
 */
export function persistInitConfig(config: CodexCommanderConfig): void {
  const mutateCurrent = () => mutatePersistedConfig(current => (
    replaceSetupConfigPreservingIntegrationIntent(current, config)
  ));
  const outcome = mutateCurrent();
  if (outcome.status !== "unavailable") return;
  if (outcome.reason === "missing") {
    withConfigMutationLockSync(() => {
      // A cooperating writer may have created the file after the missing
      // observation. Rebase through the same field-scoped replacement instead
      // of erasing the new native-client intent.
      const retry = mutateCurrent();
      if (retry.status !== "unavailable" || retry.reason !== "missing") {
        if (retry.status === "unavailable") {
          throw new Error(
            retry.reason === "invalid"
              ? "Cannot overwrite an invalid CodexCommander config."
              : "CodexCommander configuration changed repeatedly during setup; retry `ccx init`.",
          );
        }
        return;
      }
      saveConfig(config);
    });
    return;
  }
  throw new Error(
    outcome.reason === "invalid"
      ? "Cannot overwrite an invalid CodexCommander config."
      : "CodexCommander configuration changed repeatedly during setup; retry `ccx init`.",
  );
}

export async function runInit(): Promise<void> {
  const prompt = createPrompt();
  try {
    console.log("\n🔧 CodexCommander (ccx) setup\n");

    const providers = buildInitProviders();
    printMenu(providers);

    const choice = await prompt.ask("\nSelect default provider (number): ");
    const idx = parseInt(choice, 10) - 1;

    let providerName: string;
    let providerConfig: CodexCommanderProviderConfig;
    let oauthHint = false;

    if (idx >= 0 && idx < providers.length) {
      const p = providers[idx];
      providerName = p.id;
      console.log(`\n📡 ${p.label}`);
      console.log(`   Base URL: ${p.baseUrl}`);

      if (p.kind === "forward") {
        providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "forward" };
        console.log("   No API key needed — forwards your existing `codex login`.");
      } else if (p.kind === "oauth") {
        providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "oauth", ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) };
        oauthHint = true;
      } else {
        // key + local: collect a key (local usually blank).
        if (p.dashboardUrl) console.log(`   🔑 Get your key: ${p.dashboardUrl}`);
        // Template URL with placeholders (e.g. Cloudflare's {account_id}) needs a resolved value.
        let baseUrl = p.baseUrl;
        if (/\{[^}]*\}/.test(baseUrl)) {
          const resolved = (await prompt.ask(`   Your endpoint URL (${baseUrl}): `)).trim();
          if (!resolved) {
            console.error("   A resolved URL is required — replace the {placeholder} with your actual value.");
            process.exit(1);
          }
          baseUrl = resolved;
        }
        const env = envKeyFor(p.id);
        const hint = p.kind === "local" ? "API key (usually blank — press Enter): " : `API key (paste, or env var $${env}): `;
        const apiKey = (await prompt.ask(`\n${hint}`)).trim();
        const modelChoice = (await prompt.ask(`Default model${p.defaultModel ? ` [${p.defaultModel}]` : " (optional)"}: `)).trim();
        const defaultModel = modelChoice || p.defaultModel;
        providerConfig = {
          adapter: p.adapter,
          baseUrl,
          ...(p.kind === "key" ? { apiKey: apiKey || `\${${env}}` } : apiKey ? { apiKey } : {}),
          ...(defaultModel ? { defaultModel } : {}),
        };
        // Apply the catalog's models / vision classification (same enrichment as the GUI).
        enrichProviderFromCatalog(p.id, providerConfig);
      }
    } else {
      providerName = (await prompt.ask("Provider name: ")).trim();
      if (!isValidProviderName(providerName)) {
        console.error("Provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key.");
        process.exit(1);
      }
      const baseUrl = await prompt.ask("Base URL (e.g. http://localhost:11434/v1): ");
      const adapter = await prompt.ask("Adapter [openai-chat]: ") || "openai-chat";
      const apiKey = await prompt.ask("API key (optional): ");
      const defaultModel = await prompt.ask("Default model: ");
      providerConfig = {
        adapter: adapter.trim(),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
      };
    }

    const portStr = await prompt.ask("\nProxy port [10100]: ");
    const port = parseInt(portStr, 10) || 10100;

    const config: CodexCommanderConfig = {
      ...getDefaultConfig(),
      port,
      providers: { [providerName]: providerConfig },
      defaultProvider: providerName,
    };

    persistInitConfig(config);
    console.log(`\n✅ Config saved to ${getConfigPath()}`);
    if (oauthHint) console.log(`🔐 Authenticate this provider with:  ccx login ${providerName}`);

    const routeAnswer = await prompt.ask("Route Codex through a running proxy now? [Y/n]: ");
    if (routeAnswer.trim().toLowerCase() !== "n") {
      console.log("Verifying the running proxy and synchronizing models...");
      const result = await routeCodexThroughLiveProxyFromInit();
      if (result.ok) {
        console.log(`✅ ${result.message}`);
      } else {
        console.log(`⚠️  ${result.message} Codex routing was left unchanged; run 'ccx start' to start and route the proxy.`);
      }
    }

    const shimAnswer = await prompt.ask("Install Codex autostart shim? [Y/n]: ");
    if (shimAnswer.trim().toLowerCase() !== "n") {
      try {
        const { installCodexShim } = await import("../codex/shim");
        const result = installCodexShim();
        console.log(result.installed ? `✅ ${result.message}` : `⚠️  ${result.message}`);
      } catch (err) {
        console.log(`⚠️  Codex autostart shim skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\n🚀 Setup complete! Run 'ccx start' to start the proxy.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/stdin (closed|reached EOF)/i.test(message)) {
      console.error(`\n❌ ${message}. Re-run \`ccx init\` in an interactive terminal.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    prompt.close();
  }
}
