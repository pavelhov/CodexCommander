/** Management routes for external client integrations owned by OpenCodex. */
import {
  OPENCODE_CONSOLE_URL,
  OPENCODE_DOWNLOAD_URL,
  detectOpencodeInstallation,
  launchInstalledOpencode,
} from "../../clients/opencode-installation";
import {
  applyOpencodeIntegration,
  inspectOpencodeIntegration,
  resolveOpencodeAdmissionToken,
  restoreOpencodeIntegration,
  setOpencodeAutoConnect,
} from "../../clients/opencode-persistence";
import {
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  opencodeProxyBaseUrl,
  type OpencodeGeneratedConfig,
  type OpencodeProviderBlock,
} from "../../clients/config-export";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { listManagementModelRows, toExportModel } from "./model-routes";
import type { OcxConfig } from "../../types";
import { providerCredentialVerification } from "../../providers/credential-verification";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function buildPersistentOpencodeProviderBlock(
  config: OcxConfig,
  port: number,
): Promise<OpencodeProviderBlock> {
  const rows = await listManagementModelRows(config);
  const models = rows.filter(row => !row.disabled).map(toExportModel);
  const document = buildClientConfig("opencode", {
    baseUrl: opencodeProxyBaseUrl(port, config.hostname),
    models,
    config,
  }) as OpencodeGeneratedConfig;
  return document.provider[OPENCODE_PROVIDER_ID];
}

/** Best-effort sync used after startup/catalog changes when the user opted in. */
export async function reconcileOpencodeIntegrationIfEnabled(
  config: OcxConfig,
  port: number,
): Promise<boolean> {
  const status = inspectOpencodeIntegration();
  if (!status.autoConnect || status.state === "needs_attention") return false;
  const block = await buildPersistentOpencodeProviderBlock(config, port);
  return applyOpencodeIntegration(block, resolveOpencodeAdmissionToken(config), {
    config,
    autoConnect: true,
  }).changed;
}

function statusEnvelope(config: OcxConfig) {
  const installation = detectOpencodeInstallation();
  return {
    integration: inspectOpencodeIntegration(),
    installation,
    canOpen: installation.desktopInstalled,
    downloadUrl: OPENCODE_DOWNLOAD_URL,
    consoleUrl: OPENCODE_CONSOLE_URL,
    provider: {
      configured: !!config.providers["opencode-go"],
      credentialVerification: providerCredentialVerification(config, "opencode-go"),
    },
  };
}

function integrationError(config: OcxConfig, error: unknown, status = 409): Response {
  return jsonResponse({
    error: error instanceof Error ? error.message : String(error),
    ...statusEnvelope(config),
  }, status);
}

async function readOptionalObject(req: Request): Promise<Record<string, unknown>> {
  if (req.body === null) return {};
  let parsed: unknown;
  try { parsed = await readManagementJsonBody(req); }
  catch (error) {
    rethrowManagementBodyTooLarge(error);
    throw new Error("invalid JSON body");
  }
  if (!isRecord(parsed)) throw new Error("body must be a JSON object");
  return parsed;
}

export async function handleIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/integrations/opencode" && req.method === "GET") {
    return jsonResponse(statusEnvelope(config));
  }

  if (url.pathname === "/api/integrations/opencode/apply" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await readOptionalObject(req); }
    catch (error) { return integrationError(config, error, 400); }
    if (body.autoConnect !== undefined && typeof body.autoConnect !== "boolean") {
      return integrationError(config, new Error("autoConnect must be a boolean"), 400);
    }
    try {
      const block = await buildPersistentOpencodeProviderBlock(config, Number(url.port) || config.port);
      const result = applyOpencodeIntegration(
        block,
        resolveOpencodeAdmissionToken(config),
        {
          config,
          ...(typeof body.autoConnect === "boolean" ? { autoConnect: body.autoConnect } : {}),
        },
      );
      return jsonResponse({ ok: true, changed: result.changed, ...statusEnvelope(config) });
    } catch (error) {
      return integrationError(config, error);
    }
  }

  if (url.pathname === "/api/integrations/opencode" && req.method === "PUT") {
    let body: Record<string, unknown>;
    try { body = await readOptionalObject(req); }
    catch (error) { return integrationError(config, error, 400); }
    if (typeof body.autoConnect !== "boolean") {
      return integrationError(config, new Error("autoConnect must be a boolean"), 400);
    }
    try {
      setOpencodeAutoConnect(body.autoConnect);
      return jsonResponse({ ok: true, ...statusEnvelope(config) });
    } catch (error) {
      return integrationError(config, error);
    }
  }

  if (url.pathname === "/api/integrations/opencode/restore" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await readOptionalObject(req); }
    catch (error) { return integrationError(config, error, 400); }
    const mode = body.mode === undefined ? "surgical" : body.mode;
    if (mode !== "surgical" && mode !== "full") {
      return integrationError(config, new Error("mode must be 'surgical' or 'full'"), 400);
    }
    if (body.confirmCurrentHash !== undefined && typeof body.confirmCurrentHash !== "string") {
      return integrationError(config, new Error("confirmCurrentHash must be a string"), 400);
    }
    try {
      const result = restoreOpencodeIntegration({
        mode,
        ...(typeof body.confirmCurrentHash === "string" ? { confirmCurrentHash: body.confirmCurrentHash } : {}),
      });
      return jsonResponse({ ok: true, ...result, ...statusEnvelope(config) });
    } catch (error) {
      return integrationError(config, error);
    }
  }

  if (url.pathname === "/api/integrations/opencode/open" && req.method === "POST") {
    try {
      const installation = detectOpencodeInstallation();
      if (!installation.desktopInstalled) {
        return integrationError(config, new Error(
          installation.cliInstalled
            ? "OpenCode CLI is installed, but the desktop app is required for one-click launch. Use `ocx opencode` for the CLI."
            : "OpenCode Desktop is not installed.",
        ));
      }
      const integration = inspectOpencodeIntegration();
      if (integration.state === "needs_attention") {
        return integrationError(config, new Error(integration.detail ?? "OpenCode integration needs attention"));
      }
      if (integration.state !== "applied") {
        const block = await buildPersistentOpencodeProviderBlock(config, Number(url.port) || config.port);
        applyOpencodeIntegration(block, resolveOpencodeAdmissionToken(config), { config });
      }
      const launched = await launchInstalledOpencode();
      return jsonResponse({ ok: true, launched, ...statusEnvelope(config) });
    } catch (error) {
      return integrationError(config, error);
    }
  }

  return null;
}
