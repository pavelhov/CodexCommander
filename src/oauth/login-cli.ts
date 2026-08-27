import * as readline from "node:readline";
import { openUrl } from "../lib/open-url";
import { loadConfig, saveConfig } from "../config";
import {
  attestLiveManagementProxy,
  type ManagementAttestationIo,
} from "../server/proxy-liveness";
import { isPublicOAuthProvider, listOAuthProviders, runLogin } from "./index";
import { KEY_LOGIN_PROVIDERS, isKeyLoginProvider, validateApiKey, type KeyLoginProvider } from "./key-providers";
import type { CodexCommanderProviderConfig } from "../types";
import { configuredAdminToken } from "../lib/admin-secrets";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import { API_KEY_HEADER } from "../identity";

export function runningProxyUpdateHeaders(): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const adminToken = configuredAdminToken();
  if (adminToken) headers.set(API_KEY_HEADER, adminToken);
  return headers;
}

/** Push the new provider into a running proxy's live config so it routes without a restart. */
export async function notifyRunningProxy(
  name: string,
  provider: unknown,
  io: ManagementAttestationIo = {},
): Promise<void> {
  // Provider config may contain a durable upstream credential. Release neither the
  // body nor the admin token until the exact runtime listener proves its secret.
  const target = await attestLiveManagementProxy(io);
  if (!target) return;
  try {
    await (io.fetchFn ?? fetch)(`${target.baseUrl}/api/providers`, {
      method: "POST",
      headers: runningProxyUpdateHeaders(),
      body: JSON.stringify({ name, provider }),
    });
  } catch {
    /* proxy unreachable; disk config loads on next start */
  }
}

/**
 * After `runLogin()` has persisted the merged provider (including preserved apiKey /
 * apiKeyPool / authMode), push that on-disk entry into a running proxy.
 *
 * Must not send `OAUTH_PROVIDERS[name].providerConfig`: POST /api/providers replaces the
 * live entry and saves it, which would drop the preserved key billing state.
 */
export async function notifyRunningProxyAfterOAuthLogin(
  name: string,
  io: ManagementAttestationIo = {},
): Promise<void> {
  const provider = loadConfig().providers[name];
  if (!provider) return;
  await notifyRunningProxy(name, provider, io);
}

export async function handleLogin(provider?: string): Promise<void> {
  const name = (provider ?? "").trim().toLowerCase();
  if (isPublicOAuthProvider(name)) return handleOAuthLogin(name);
  if (isKeyLoginProvider(name)) return handleKeyLogin(name);
  console.error(
    `Usage: ccx login <provider>\n` +
      `  OAuth login:   ${listOAuthProviders().join(", ")}\n` +
      `  API-key login: ${Object.keys(KEY_LOGIN_PROVIDERS).join(", ")}`,
  );
  process.exit(1);
}

async function handleOAuthLogin(name: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runLogin(name, {
      onAuth: ({ url, instructions }) => {
        console.log(`\n🔐 Opening browser for ${name} login...\n${url}\n`);
        if (instructions) console.log(instructions);
        openUrl(url);
      },
      onProgress: (m) => console.log(`   ${m}`),
      onManualCodeInput: () =>
        new Promise((res) => rl.question("Paste redirect URL or code (or wait for browser): ", res)),
    });
  } finally {
    rl.close();
  }
  await notifyRunningProxyAfterOAuthLogin(name);
  console.log(`\n✅ Logged in to ${name}. Try: ccx sync`);
}

export function providerConfigFromKeyLoginProvider(def: KeyLoginProvider, key: string, baseUrlOverride?: string): CodexCommanderProviderConfig {
  return {
    adapter: def.adapter,
    baseUrl: baseUrlOverride ?? def.baseUrl,
    authMode: "key",
    apiKey: key,
    ...(def.apiKeyTransport !== undefined ? { apiKeyTransport: def.apiKeyTransport } : {}),
    ...(def.defaultModel ? { defaultModel: def.defaultModel } : {}),
    ...(def.models ? { models: [...def.models] } : {}),
    ...(def.contextWindow !== undefined ? { contextWindow: def.contextWindow } : {}),
    ...(def.modelContextWindows ? { modelContextWindows: { ...def.modelContextWindows } } : {}),
    ...(def.modelMaxInputTokens ? { modelMaxInputTokens: { ...def.modelMaxInputTokens } } : {}),
    ...(def.defaultMaxOutputTokens !== undefined ? { defaultMaxOutputTokens: def.defaultMaxOutputTokens } : {}),
    ...(def.modelMaxOutputTokens ? { modelMaxOutputTokens: { ...def.modelMaxOutputTokens } } : {}),
    ...(def.chatCompletionTokenField !== undefined ? { chatCompletionTokenField: def.chatCompletionTokenField } : {}),
    ...(def.modelInputModalities ? { modelInputModalities: cloneRecordOfArrays(def.modelInputModalities) } : {}),
    ...(def.reasoningEfforts ? { reasoningEfforts: [...def.reasoningEfforts] } : {}),
    ...(def.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(def.modelReasoningEfforts) } : {}),
    ...(def.reasoningEffortMap ? { reasoningEffortMap: { ...def.reasoningEffortMap } } : {}),
    ...(def.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(def.modelReasoningEffortMap) } : {}),
    ...(def.noVisionModels ? { noVisionModels: [...def.noVisionModels] } : {}),
    ...(def.noReasoningModels ? { noReasoningModels: [...def.noReasoningModels] } : {}),
    ...(def.noTemperatureModels ? { noTemperatureModels: [...def.noTemperatureModels] } : {}),
    ...(def.noTopPModels ? { noTopPModels: [...def.noTopPModels] } : {}),
    ...(def.noPenaltyModels ? { noPenaltyModels: [...def.noPenaltyModels] } : {}),
    ...(def.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...def.autoToolChoiceOnlyModels] } : {}),
    ...(def.preserveReasoningContentModels ? { preserveReasoningContentModels: [...def.preserveReasoningContentModels] } : {}),
    ...(def.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: def.escapeBuiltinToolNames } : {}),
  };
}

async function handleKeyLogin(name: string): Promise<void> {
  const def = KEY_LOGIN_PROVIDERS[name];
  const preflightConfig = loadConfig();
  const namespaceCollision = codexAccountNamespaceProviderCollisionError(preflightConfig.codexAccountNamespaces, name);
  if (namespaceCollision) {
    console.error(`Error: ${namespaceCollision}.`);
    process.exit(1);
  }
  console.log(`\n🔑 ${def.label} — opening ${def.dashboardUrl} so you can create/copy an API key...`);
  openUrl(def.dashboardUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await new Promise<string>((res) => rl.question(`Paste your ${def.label} API key: `, res))).trim();
  // Template URL with placeholders needs resolution before saving.
  let baseUrl = def.baseUrl;
  if (/\{[^}]*\}/.test(baseUrl)) {
    const resolved = (await new Promise<string>((res) => rl.question(`Your endpoint URL (${baseUrl}): `, res))).trim();
    if (!resolved) {
      rl.close();
      console.error("A resolved URL is required — replace the {placeholder} with your actual value.");
      process.exit(1);
    }
    baseUrl = resolved;
  }
  rl.close();
  if (!key) {
    console.error("No key entered.");
    process.exit(1);
  }
  process.stdout.write("   validating… ");
  const valid = await validateApiKey(name, { ...def, baseUrl }, key);
  console.log(valid === true ? "valid ✅" : valid === false ? "INVALID ❌" : "couldn't validate (may still work)");
  if (valid === false) {
    console.error("Provider rejected the key. Not saved.");
    process.exit(1);
  }
  const provider = providerConfigFromKeyLoginProvider(def, key, baseUrl);
  const config = loadConfig();
  const commitCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, name);
  if (commitCollision) {
    console.error(`Error: ${commitCollision}.`);
    process.exit(1);
  }
  config.providers[name] = provider;
  saveConfig(config);
  await notifyRunningProxy(name, provider);
  console.log(`✅ ${def.label} added. Try: ccx sync`);
}

function cloneRecordOfArrays(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, [...value]]));
}

function cloneNestedRecord(input: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}
