/** `ccx account` — list and switch provider credentials (issue #180). */
import { loadConfig } from "../config";
import { providerCodexAccountMode } from "../providers/registry";
import type { CodexCommanderConfig } from "../types";
import { cmdAddKey, cmdAlias, cmdAutoSwitch, cmdClearCooldown, cmdPriority, cmdRefresh, cmdRemove } from "./account-extended";
import { apiError, apiJson, classifyAccount, fetchRows, gateXaiKeyAction, proxyUnreachable, resolveBaseUrl, type AccountDeps, type AccountRow, type AccountType, type ApiResult }
  from "./account-api";

export { classifyAccount } from "./account-api";
export type { AccountDeps, AccountRow, AccountType, ClassifyResult } from "./account-api";
type TargetProvenance = "live-oauth-list" | "config" | "codex";

const MAIN_ALIAS = "main";
const MAIN_CODEX_ID = "__main__";
/** Replacement-style single-slot OAuth (no stable identity; not HTTP-derivable). */
const REPLACEMENT_STYLE_OAUTH = new Set(["kiro"]);

const ACCOUNT_USAGE = `Usage:
  ccx account list [provider] [--json] [--all]
  ccx account current <provider> [--json]
  ccx account use <provider> <account-or-key-id|main> [--json]
  ccx account refresh <provider> [--json]
  ccx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]
  ccx account alias <provider> <account-or-key-id> <display-name|-> [--json]
  ccx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]
  ccx account remove <provider> <account-or-key-id|main> --yes [--json]
  ccx account clear-cooldown <provider> <account-id|main> [--json]
  ccx account add-key <provider> [--label <label>] [--json]
  ccx account login <provider> [--id <account-id>] [--reauth] [--code -] [--no-wait] [--json]
  ccx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
  ccx account cancel <provider> [--flow <flow-id>] [--json]
  ccx account reset-credits <account-id|main> [--consume --yes] [--json]
  ccx account main <doctor|list|register|add|switch|recover> ...

List and switch provider accounts and API-key pools (masked output only).
'main' selects the Codex App login for the openai account pool.`;

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Returns an error message for leftover args, or null when clean. */
function leftoverArgsError(args: string[]): string | null {
  if (args.length === 0) return null;
  const unknown = args.filter(a => a.startsWith("-"));
  return unknown.length > 0
    ? `Unknown flag(s): ${unknown.join(", ")}`
    : `Unexpected argument(s): ${args.join(", ")}`;
}

function candidateNames(config: CodexCommanderConfig): string {
  const names = new Set<string>(["openai"]);
  for (const n of Object.keys(config.providers ?? {})) names.add(n);
  return [...names].join(", ");
}

function displayId(id: string): string {
  return id === MAIN_CODEX_ID ? MAIN_ALIAS : id;
}

function statusText(row: AccountRow): string {
  const parts: string[] = [];
  if (row.active) parts.push(row.type === "codex" ? "selected" : "active");
  if (row.needsReauth) parts.push("needs-reauth");
  return parts.join(" ");
}

/** Signed so the sort direction reads off the column; "-" where ordering does not apply. */
function priorityText(row: AccountRow): string {
  if (row.priority === undefined) return "-";
  return row.priority > 0 ? `+${row.priority}` : String(row.priority);
}

export function formatAccountTable(rows: AccountRow[]): string {
  const header = ["PROVIDER", "TYPE", "ID", "PLAN/LABEL", "PRIORITY", "STATUS"];
  const data = rows.map(r => {
    const keyLabel = r.masked && r.label !== r.masked ? `${r.masked} (${r.label})` : r.masked;
    return [
      r.provider,
      r.type,
      displayId(r.id),
      r.type === "api-key" ? keyLabel ?? "-" : r.label ?? "-",
      priorityText(r),
      statusText(r),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...data.map(d => d[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...data.map(line)].join("\n");
}

async function cmdList(rest: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const showAll = consumeFlag(rest, "--all");
  const name = rest.shift();
  const leftover = leftoverArgsError(rest);
  if (leftover) {
    console.error(leftover);
    console.error(ACCOUNT_USAGE);
    return 1;
  }
  const config = deps.loadConfigImpl?.() ?? loadConfig();
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  const targets: { name: string; type: AccountType; provenance: TargetProvenance }[] = [];
  if (name) {
    const c = classifyAccount(config, name);
    if ("error" in c) {
      console.error(`Error: ${c.error}. Known candidates: ${candidateNames(config)}`);
      return 1;
    }
    targets.push({ name, type: c.type, provenance: "config" });
  } else {
    const seen = new Set<string>();
    const push = (n: string, provenance: TargetProvenance) => {
      if (seen.has(n)) return;
      seen.add(n);
      const c = classifyAccount(config, n);
      if ("error" in c) return; // fan-out silently skips no-credential providers
      targets.push({ name: n, type: c.type, provenance });
    };
    push("openai", "codex");
    const providersRes = await apiJson(deps, baseUrl, "GET", "/api/oauth/providers");
    if (providersRes.status === 0) return proxyUnreachable();
    if (providersRes.status !== 200) return apiError(providersRes.json, "failed to list OAuth providers");
    if (Array.isArray(providersRes.json.providers)) {
      for (const p of providersRes.json.providers) {
        if (typeof p === "string") push(p, "live-oauth-list");
      }
    }
    for (const n of Object.keys(config.providers ?? {})) push(n, "config");
  }

  const rows: AccountRow[] = [];
  const notes: string[] = [];
  for (const t of targets) {
    // Canonical xAI is intentionally dual-family: chat may remain OAuth while
    // its separately attested media-key pool is dormant. List both so masked
    // key ids remain discoverable for later selection/removal.
    const xaiProvider = t.name === "xai" ? config.providers?.xai : undefined;
    const familyTypes: AccountType[] = t.name === "xai"
      && t.type === "oauth"
      && Boolean(xaiProvider?.apiKey || (xaiProvider?.apiKeyPool?.length ?? 0) > 0)
      ? ["oauth", "api-key"]
      : [t.type];
    let targetRowCount = 0;
    for (const familyType of familyTypes) {
      const r = await fetchRows(deps, baseUrl, t.name, familyType);
      if (r.networkDown) return proxyUnreachable();
      if (r.errorJson) {
        if (name) return apiError(r.errorJson, `failed to list ${t.name}`);
        const errorText = typeof r.errorJson.error === "string" ? r.errorJson.error : "";
        const skipUnknownKey = familyType === "api-key"
          && r.status === 404
          && errorText.includes("unknown provider");
        const skipConfigOAuth = familyType === "oauth"
          && t.provenance === "config"
          && r.status === 400
          && errorText.includes("unknown oauth provider");
        if (skipUnknownKey || skipConfigOAuth) continue;
        return apiError(r.errorJson, `failed to list ${t.name}`);
      }
      targetRowCount += r.rows.length;
      rows.push(...r.rows);
      if (familyType === "codex") {
        if (r.activeId === null) notes.push("openai: auto (no pin — lowest-usage account is selected per request)");
        if (providerCodexAccountMode("openai", config.providers?.openai) === "direct") {
          notes.push("openai is in direct mode — the selection takes effect when pool mode is enabled");
        }
      }
      if (familyType === "oauth" && REPLACEMENT_STYLE_OAUTH.has(t.name)) {
        notes.push(`${t.name}: single login slot — re-login replaces the current account`);
      }
    }
    if (targetRowCount === 0 && showAll) notes.push(`${t.name}: no stored accounts or keys`);
  }

  if (wantsJson) {
    console.log(JSON.stringify({ accounts: rows, notes }, null, 2));
    return 0;
  }
  if (rows.length > 0) console.log(formatAccountTable(rows));
  for (const n of notes) console.log(n);
  if (rows.length === 0 && notes.length === 0) console.log("No stored accounts or keys.");
  return 0;
}

async function cmdCurrent(rest: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const name = rest.shift();
  const leftover = leftoverArgsError(rest);
  if (!name || leftover) {
    if (leftover) console.error(leftover);
    console.error(ACCOUNT_USAGE);
    return 1;
  }
  const config = deps.loadConfigImpl?.() ?? loadConfig();
  const c = classifyAccount(config, name);
  if ("error" in c) {
    console.error(`Error: ${c.error}. Known candidates: ${candidateNames(config)}`);
    return 1;
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const primary = await fetchRows(deps, baseUrl, name, c.type);
  if (primary.networkDown) return proxyUnreachable();
  if (primary.errorJson) return apiError(primary.errorJson, `failed to read ${name}`);
  const xaiProvider = name === "xai" ? config.providers?.xai : undefined;
  const keyFamily = name === "xai"
    && c.type === "oauth"
    && Boolean(xaiProvider?.apiKey || (xaiProvider?.apiKeyPool?.length ?? 0) > 0)
    ? await fetchRows(deps, baseUrl, name, "api-key")
    : null;
  if (keyFamily?.networkDown) return proxyUnreachable();
  if (keyFamily?.errorJson) return apiError(keyFamily.errorJson, `failed to read ${name} media keys`);

  const activeRow = primary.rows.find(row => row.active) ?? null;
  const activeKey = keyFamily?.rows.find(row => row.active) ?? null;
  if (wantsJson) {
    console.log(JSON.stringify({
      provider: name,
      type: c.type,
      activeId: primary.activeId,
      autoSwitchThreshold: primary.autoSwitchThreshold,
      account: activeRow,
      ...(keyFamily ? { mediaKeyActiveId: keyFamily.activeId, mediaKey: activeKey } : {}),
    }, null, 2));
    return 0;
  }
  const activeRows = [activeRow, activeKey].filter((row): row is AccountRow => row !== null);
  if (activeRows.length > 0) {
    console.log(formatAccountTable(activeRows));
  } else if (c.type === "codex" && primary.activeId === null) {
    console.log("openai: auto (no pin — lowest-usage account is selected per request)");
  } else {
    console.log(`${name}: no active account or key`);
  }
  return 0;
}

async function cmdUse(rest: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const name = rest.shift();
  const id = rest.shift();
  const leftover = leftoverArgsError(rest);
  if (!name || !id || leftover) {
    if (leftover) console.error(leftover);
    console.error(ACCOUNT_USAGE);
    return 1;
  }
  const config = deps.loadConfigImpl?.() ?? loadConfig();
  const c = classifyAccount(config, name);
  if ("error" in c) {
    console.error(`Error: ${c.error}. Known candidates: ${candidateNames(config)}`);
    return 1;
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  let effectiveType = c.type;
  if (name === "xai" && c.type === "oauth") {
    const keyPool = await fetchRows(deps, baseUrl, name, "api-key");
    if (!keyPool.networkDown && !keyPool.errorJson && keyPool.rows.some(row => row.id === id)) {
      effectiveType = "api-key";
    }
  }

  let res: ApiResult;
  let activeId: string;
  if (effectiveType === "codex") {
    activeId = id === MAIN_ALIAS ? MAIN_CODEX_ID : id;
    res = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/active", { accountId: activeId });
  } else if (effectiveType === "oauth") {
    activeId = id;
    res = await apiJson(deps, baseUrl, "PUT", "/api/oauth/accounts/active", { provider: name, accountId: id });
  } else {
    activeId = id;
    if (name === "xai") {
      const gate = await gateXaiKeyAction(deps, baseUrl, `Select xAI media API key ${id}?`);
      if (!gate) return 1;
      res = await apiJson(
        deps,
        baseUrl,
        "PUT",
        "/api/providers/keys/active",
        { name, id, expectedRevision: gate.revision },
        {
          target: gate.target,
          actionAttestation: { action: "xai_key_select", target: "xai_key", id },
        },
      );
    } else {
      res = await apiJson(deps, baseUrl, "PUT", "/api/providers/keys/active", { name, id });
    }
  }
  if (res.status === 0) return proxyUnreachable();
  if (res.status !== 200) return apiError(res.json, `failed to switch ${name}`);

  if (wantsJson) console.log(JSON.stringify({ ok: true, provider: name, type: effectiveType, activeId }, null, 2));
  else console.log(`${name}: active ${effectiveType === "api-key" ? "key" : "account"} is now ${displayId(activeId)}`);
  if (effectiveType === "codex") {
    console.error("Takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.");
    const active = await apiJson(deps, baseUrl, "GET", "/api/codex-auth/active");
    if (active.status === 200 && typeof active.json.autoSwitchThreshold === "number" && active.json.autoSwitchThreshold > 0) {
      console.error(`Note: auto-switch (threshold ${active.json.autoSwitchThreshold}%) may override this pin.`);
    }
  }
  return 0;
}

export async function cmdAccount(args: string[], deps: AccountDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "list") return await cmdList(rest, deps);
    if (sub === "current") return await cmdCurrent(rest, deps);
    if (sub === "use") return await cmdUse(rest, deps);
    if (sub === "refresh") return await cmdRefresh(rest, deps);
    if (sub === "auto-switch") return await cmdAutoSwitch(rest, deps);
    if (sub === "alias" || sub === "rename") return await cmdAlias(rest, deps);
    if (sub === "priority") return await cmdPriority(rest, deps);
    if (sub === "remove") return await cmdRemove(rest, deps);
    if (sub === "clear-cooldown") return await cmdClearCooldown(rest, deps);
    if (sub === "add-key") return await cmdAddKey(rest, deps);
    if (sub === "main") {
      const { cmdNativeMainAccount } = await import("./account-main");
      return await cmdNativeMainAccount(rest, deps);
    }
    if (["login", "reauth", "code", "cancel", "reset-credits"].includes(sub ?? "")) {
      const { handleAccountAuthCommand } = await import("./account-auth");
      return await handleAccountAuthCommand(sub!, rest, deps) ?? 1;
    }
    console.error(ACCOUNT_USAGE);
    return 1;
  } catch (err) {
    console.error(`account: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
