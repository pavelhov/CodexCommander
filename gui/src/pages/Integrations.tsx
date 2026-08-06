import { useCallback, useEffect, useRef, useState } from "react";
import { setClientResourceData, useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { IconAlert, IconCheck, IconExternal, IconLink, IconLock, IconRefresh } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { homeDisplayPath } from "../integration-path";
import { providerRouteHash } from "../provider-route";
import { Switch } from "../ui";

type IntegrationState = "not_applied" | "applied" | "modified" | "needs_attention";
type BusyAction = "apply" | "open" | "restore" | "auto";

interface OpenCodeIntegrationEnvelope {
  integration: {
    state: IntegrationState;
    targetPath: string;
    autoConnect: boolean;
    canRestore: boolean;
    tokenReady: boolean;
    detail?: string;
  };
  installation: {
    desktopInstalled: boolean;
    cliInstalled: boolean;
    preferred: "desktop" | "cli" | null;
  };
  canOpen: boolean;
  downloadUrl: string;
  consoleUrl: string;
  provider: {
    configured: boolean;
    credentialVerification: "not_configured" | "unverified" | "verified" | null;
  };
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOpenCodeIntegrationEnvelope(value: unknown): value is OpenCodeIntegrationEnvelope {
  if (!isRecord(value) || !isRecord(value.integration) || !isRecord(value.installation) || !isRecord(value.provider)) {
    return false;
  }
  const integration = value.integration;
  const installation = value.installation;
  const provider = value.provider;
  const states = new Set<IntegrationState>(["not_applied", "applied", "modified", "needs_attention"]);
  const preferred = installation.preferred;
  const verification = provider.credentialVerification;
  return typeof integration.state === "string" && states.has(integration.state as IntegrationState)
    && typeof integration.targetPath === "string"
    && typeof integration.autoConnect === "boolean"
    && typeof integration.canRestore === "boolean"
    && typeof integration.tokenReady === "boolean"
    && (integration.detail === undefined || typeof integration.detail === "string")
    && typeof installation.desktopInstalled === "boolean"
    && typeof installation.cliInstalled === "boolean"
    && (preferred === null || preferred === "desktop" || preferred === "cli")
    && typeof value.canOpen === "boolean"
    && typeof value.downloadUrl === "string"
    && typeof value.consoleUrl === "string"
    && typeof provider.configured === "boolean"
    && (verification === null || verification === "not_configured" || verification === "unverified" || verification === "verified");
}

const STATE_KEYS: Record<IntegrationState, TKey> = {
  not_applied: "integrations.state.notApplied",
  applied: "integrations.state.applied",
  modified: "integrations.state.modified",
  needs_attention: "integrations.state.needsAttention",
};

export default function Integrations({ apiBase }: { apiBase: string }) {
  const t = useT();
  const resourceKey = `integrations-opencode:${apiBase}`;
  const load = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(`${apiBase}/api/integrations/opencode`, { signal });
    const data = await readJsonOrThrow<unknown>(response, t("integrations.loadFailed"));
    if (!isOpenCodeIntegrationEnvelope(data)) throw new Error(t("integrations.loadFailed"));
    return data;
  }, [apiBase, t]);
  const resource = useKeyedClientResource(resourceKey, [apiBase], load, { pollMs: 30_000 });
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);

  const runAction = useCallback(async (
    action: BusyAction,
    path: string,
    init: RequestInit,
    successKey: TKey,
  ) => {
    if (busy) return;
    setBusy(action);
    setFeedback(null);
    try {
      const response = await fetch(`${apiBase}${path}`, init);
      const data = await readJsonOrThrow<unknown>(response, t("integrations.actionFailed"));
      if (!isOpenCodeIntegrationEnvelope(data)) throw new Error(t("integrations.actionFailed"));
      setClientResourceData(resourceKey, data);
      setFeedback({ tone: "ok", text: t(successKey) });
    } catch (error) {
      setFeedback({
        tone: "err",
        text: error instanceof Error ? error.message : t("integrations.actionFailed"),
      });
      resource.refresh();
    } finally {
      setBusy(null);
    }
  }, [apiBase, busy, resource, resourceKey, t]);

  const data = resource.data;
  const integration = data?.integration;
  const installed = data?.installation.desktopInstalled === true;
  const state = integration?.state ?? "not_applied";
  const stateTone = state === "applied"
    ? "ok"
    : state === "needs_attention"
      ? "err"
      : state === "modified"
        ? "warn"
        : "neutral";
  const credential = data?.provider.credentialVerification;
  const credentialKey: TKey = credential === "verified"
    ? "integrations.credential.verified"
    : credential === "unverified"
      ? "integrations.credential.unverified"
      : credential === "not_configured"
        ? "integrations.credential.missing"
        : "integrations.credential.notAvailable";

  const apply = () => void runAction(
    "apply",
    "/api/integrations/opencode/apply",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoConnect: integration?.autoConnect ?? false }),
    },
    "integrations.appliedSuccess",
  );
  const open = () => void runAction(
    "open",
    "/api/integrations/opencode/open",
    { method: "POST" },
    "integrations.openedSuccess",
  );
  const restore = () => {
    setRestoreConfirmOpen(false);
    void runAction(
      "restore",
      "/api/integrations/opencode/restore",
      { method: "POST" },
      "integrations.restoredSuccess",
    );
  };
  const toggleAuto = () => void runAction(
    "auto",
    "/api/integrations/opencode",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoConnect: !integration?.autoConnect }),
    },
    integration?.autoConnect ? "integrations.autoDisabled" : "integrations.autoEnabled",
  );

  return (
    <div className="integrations-page">
      <div className="page-head integrations-head">
        <div>
          <h1>{t("integrations.title")}</h1>
          <p className="page-sub">{t("integrations.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => resource.refresh()}
          disabled={resource.refreshing || busy !== null}
        >
          <IconRefresh aria-hidden />
          {resource.refreshing ? t("integrations.refreshing") : t("integrations.refresh")}
        </button>
      </div>

      {resource.loading && !data ? (
        <section className="panel integrations-loading" role="status" aria-live="polite">
          <div className="integration-skeleton integration-skeleton-mark" />
          <div className="integration-skeleton-stack">
            <div className="integration-skeleton integration-skeleton-title" />
            <div className="integration-skeleton integration-skeleton-copy" />
          </div>
          <span className="sr-only">{t("common.loading")}</span>
        </section>
      ) : resource.error && !data ? (
        <section className="panel integrations-empty" role="alert">
          <IconAlert aria-hidden />
          <div>
            <h2>{t("integrations.loadFailedTitle")}</h2>
            <p className="muted">{t("integrations.loadFailed")}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => resource.refresh()}>
            {t("common.retry")}
          </button>
        </section>
      ) : data && integration ? (
        <>
          <section className="panel integration-card integration-card-primary">
            <div className="integration-card-top">
              <div className="integration-identity">
                <span className="integration-mark" aria-hidden="true">
                  <img src="/provider-icons/opencode.svg" alt="" width={34} height={34} />
                </span>
                <div>
                  <div className="integration-title-row">
                    <h2>OpenCode</h2>
                    <span className={`integration-badge integration-badge-${installed ? "ok" : "neutral"}`}>
                      {installed ? <IconCheck aria-hidden /> : <IconAlert aria-hidden />}
                      {t(installed ? "integrations.installed" : "integrations.notInstalled")}
                    </span>
                    <span className={`integration-badge integration-badge-${stateTone}`}>
                      {state === "applied" ? <IconCheck aria-hidden /> : <IconLink aria-hidden />}
                      {t(STATE_KEYS[state])}
                    </span>
                  </div>
                  <p className="muted integration-description">{t("integrations.opencodeDescription")}</p>
                </div>
              </div>

              <div className="integration-actions">
                {installed ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={open}
                    disabled={busy !== null || state === "needs_attention"}
                  >
                    {busy === "open" ? t("integrations.opening") : t("integrations.open")}
                  </button>
                ) : (
                  <a className="btn btn-primary" href={data.downloadUrl} target="_blank" rel="noreferrer">
                    {t("integrations.download")} <IconExternal aria-hidden />
                  </a>
                )}
                <button type="button" className="btn" onClick={apply} disabled={busy !== null || state === "needs_attention"}>
                  {busy === "apply"
                    ? t("integrations.applying")
                    : state === "not_applied"
                      ? t("integrations.applyConnection")
                      : t("integrations.refreshConnection")}
                </button>
                {integration.canRestore && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setRestoreConfirmOpen(true)}
                    disabled={busy !== null}
                  >
                    {busy === "restore" ? t("integrations.restoring") : t("integrations.restore")}
                  </button>
                )}
              </div>
            </div>

            {!installed && data.installation.cliInstalled && (
              <p className="integration-inline-note">{t("integrations.cliInstalledHint")}</p>
            )}
            {(state === "modified" || state === "needs_attention") && (
              <div className={`integration-notice integration-notice-${state === "needs_attention" ? "err" : "warn"}`} role="status">
                <IconAlert aria-hidden />
                <span>{integration.detail || t(state === "modified" ? "integrations.modifiedHint" : "integrations.attentionHint")}</span>
              </div>
            )}
            {feedback && (
              <div className={`integration-notice integration-notice-${feedback.tone}`} role="status" aria-live="polite">
                {feedback.tone === "ok" ? <IconCheck aria-hidden /> : <IconAlert aria-hidden />}
                <span>{feedback.text}</span>
              </div>
            )}

            <div className="integration-settings">
              <div className="integration-setting-copy">
                <span className="integration-setting-title">{t("integrations.autoConnect")}</span>
                <span className="muted">{t("integrations.autoConnectHint")}</span>
              </div>
              <Switch
                on={integration.autoConnect}
                onClick={toggleAuto}
                disabled={busy !== null || state === "not_applied" || state === "needs_attention"}
                label={t("integrations.autoConnect")}
              />
            </div>

            <dl className="integration-facts">
              <div>
                <dt>{t("integrations.destination")}</dt>
                <dd><code>{homeDisplayPath(integration.targetPath)}</code></dd>
              </div>
              <div>
                <dt>{t("integrations.models")}</dt>
                <dd>{t("integrations.modelsManaged")}</dd>
              </div>
              <div>
                <dt>{t("integrations.credentials")}</dt>
                <dd>{t("integrations.credentialsProtected")}</dd>
              </div>
            </dl>
          </section>

          <div className="integration-secondary-grid">
            <section className="panel integration-card integration-provider-card">
              <div className="integration-mini-icon"><IconLink aria-hidden /></div>
              <div className="integration-provider-copy">
                <div className="integration-title-row">
                  <h2>{t("integrations.providerName")}</h2>
                  <span className={`integration-badge integration-badge-${data.provider.configured ? "ok" : "neutral"}`}>
                    {data.provider.configured ? <IconCheck aria-hidden /> : <IconAlert aria-hidden />}
                    {t(data.provider.configured ? "integrations.providerConfigured" : "integrations.providerNotConfigured")}
                  </span>
                </div>
                <p className="muted">{t("integrations.providerDescription")}</p>
                <p className="integration-credential-line">
                  <IconLock aria-hidden /> {t(credentialKey)}
                </p>
              </div>
              <div className="integration-provider-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    window.location.hash = data.provider.configured
                      ? providerRouteHash("opencode-go", "accounts")
                      : "providers";
                  }}
                >
                  {t(data.provider.configured ? "integrations.manageProvider" : "integrations.setupProvider")}
                </button>
                <a className="btn btn-ghost" href={data.consoleUrl} target="_blank" rel="noreferrer">
                  {t("integrations.openConsole")} <IconExternal aria-hidden />
                </a>
              </div>
            </section>

            <section className="panel integration-card integration-security-card">
              <div className="integration-mini-icon"><IconLock aria-hidden /></div>
              <div>
                <h2>{t("integrations.securityTitle")}</h2>
                <p className="muted">{t("integrations.securityBody")}</p>
              </div>
            </section>
          </div>
        </>
      ) : null}
      {restoreConfirmOpen && (
        <RestoreIntegrationDialog
          onCancel={() => setRestoreConfirmOpen(false)}
          onConfirm={restore}
        />
      )}
    </div>
  );
}

function RestoreIntegrationDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="opencode-restore-title"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={onCancel}
      />
      <div className="modal-card integration-restore-dialog" onClick={(event) => event.stopPropagation()}>
        <h3 id="opencode-restore-title">{t("integrations.restoreConfirmTitle")}</h3>
        <p className="muted">{t("integrations.restoreConfirm")}</p>
        <div className="integration-restore-dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>{t("integrations.restore")}</button>
        </div>
      </div>
    </dialog>
  );
}
