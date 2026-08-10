import { useState } from "react";
import { useI18n } from "../i18n/shared";
import { startupRiskDetailKey } from "../startup-health-ui";
import { IconAlert, IconCheck, IconChevron, IconMonitor, IconPower, IconRefresh, IconTerminal } from "../icons";
import type {
  StartupHealthData,
  StartupInstallAction,
  StartupView,
  TrayStatusData,
} from "./startup-shared";
import {
  METHOD_KEYS,
  STATUS_KEYS,
  SUMMARY_KEYS,
} from "./startup-shared";

function StartupStateBadge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`badge ${ok ? "badge-green" : "badge-amber"}`}>{ok ? yes : no}</span>;
}

export function StartupHeroSection({
  failed,
  data,
  view,
}: {
  failed: boolean;
  data: StartupHealthData;
  view: StartupView;
}) {
  const { t } = useI18n();
  const statusClass = view.hero === "at-risk"
    ? "startup-hero--risk"
    : view.hero === "native"
      ? "startup-hero--native"
      : "startup-hero--safe";
  const StatusIcon = view.hero === "at-risk"
    ? IconAlert
    : view.hero === "app-managed"
      ? IconTerminal
      : IconCheck;
  const appManaged = view.hero === "app-managed";
  // Badge and title follow the derived hero, not the raw status: a caution payload
  // without a verified companion lease renders as at-risk, not as app-managed.
  const badgeKey = appManaged
    ? "startup.hero.appManaged.badge"
    : view.hero === "at-risk"
      ? "startup.status.atRisk"
      : STATUS_KEYS[data.status];
  const titleKey = appManaged
    ? "startup.hero.appManaged.title"
    : view.hero === "at-risk"
      ? failed ? "startup.error" : "startup.summary.atRisk"
      : SUMMARY_KEYS[data.status];

  return (
    <section className={`panel startup-hero ${statusClass}`} aria-live="polite">
      <div className="startup-hero-copy">
        <span className={`badge startup-hero__badge ${view.hero === "at-risk" ? "badge-amber" : "badge-green"}`}>
          {t(badgeKey)}
        </span>
        <div className="startup-hero-main">
          <div className="startup-hero-icon"><StatusIcon /></div>
          <div className="startup-hero-text">
            <h3>{t(titleKey)}</h3>
            <p>{failed
              ? t("startup.staleData")
              : appManaged
                ? t("startup.hero.appManaged.body")
                : view.hero === "at-risk"
                  ? t(startupRiskDetailKey(data))
                  : t("startup.safeDetail")}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function StartupPrimarySection({
  data,
  view,
  failed,
  loading = false,
  installBusy,
  installResult,
  onInstall,
}: {
  data: StartupHealthData;
  view: StartupView;
  failed: boolean;
  loading?: boolean;
  installBusy: StartupInstallAction | null;
  installResult: { kind: "success" | "error"; action: StartupInstallAction; repair?: boolean; detail?: string } | null;
  onInstall: (action: StartupInstallAction, opts?: { repair?: boolean }) => void;
}) {
  const { t } = useI18n();
  const actionsDisabled = installBusy !== null || failed || loading;
  const enabling = installBusy === "install-service";

  return (
    <section className="panel startup-primary">
      <div className="startup-primary-row">
        <div className="startup-primary-row-icon"><IconMonitor /></div>
        <div className="startup-primary-row-label">{t("startup.method.current")}</div>
        <div className="startup-primary-row-value">
          {t(view.methodState === "unknown" ? "startup.method.unknown" : METHOD_KEYS[view.method])}
        </div>
        <div className="startup-primary-row-actions">
          {view.methodState === "ready" ? (
            <span className="badge badge-green"><span className="dot dot-green" aria-hidden="true" />{t("startup.state.ready")}</span>
          ) : (
            <span className="badge badge-amber">
              <span className="dot dot-amber" aria-hidden="true" />
              {t(view.methodState === "unknown" ? "startup.state.unknown" : "startup.state.attention")}
            </span>
          )}
        </div>
      </div>
      <div className="startup-primary-row">
        <div className="startup-primary-row-icon"><IconRefresh /></div>
        <div className="startup-primary-row-label">{t("startup.recovery.background")}</div>
        <div className="startup-primary-row-value">
          {t(view.crashRecovery === "on" ? "startup.recovery.on" : "startup.recovery.off")}
        </div>
        <div className="startup-primary-row-actions">
          {view.crashRecovery === "on" ? (
            <span className="badge badge-green"><span className="dot dot-green" aria-hidden="true" />{t("startup.recovery.enabled")}</span>
          ) : data.serviceSupported ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              aria-label={`${t("startup.recovery.background")} - ${t("startup.recovery.enable")}`}
              disabled={actionsDisabled}
              onClick={() => onInstall("install-service")}
            >
              {t(enabling ? "startup.recovery.enabling" : "startup.recovery.enable")}
            </button>
          ) : (
            <span className="badge badge-muted">{t("startup.recovery.unsupported")}</span>
          )}
        </div>
      </div>
      {installResult && (
        <div className={`notice ${installResult.kind === "success" ? "notice-ok" : "notice-warn"} startup-action-notice`} role="status" aria-live="polite">
          {installResult.kind === "success"
            ? installResult.action === "install-service"
              ? t(installResult.repair ? "startup.serviceRepaired" : "startup.serviceInstalled")
              : t(installResult.repair ? "startup.shimRepaired" : "startup.shimInstalled")
            : `${t("startup.installFailed")} ${installResult.detail ?? ""}`}
        </div>
      )}
    </section>
  );
}

export function StartupTraySection({
  tray,
  trayLoading,
  trayError,
  trayBusy,
  onTrayAction,
}: {
  tray: TrayStatusData | null;
  trayLoading: boolean;
  trayError: boolean;
  trayBusy: boolean;
  onTrayAction: (action: "install" | "start" | "stop" | "uninstall") => void;
}) {
  const { t } = useI18n();

  return (
    <section className="panel startup-actions">
      <div className="panel-head">
        <h3 className="panel-title">{t("startup.tray.title")}</h3>
        <IconPower />
      </div>
      <p className="muted">{t("startup.tray.hint")}</p>
      <div className="startup-detail-row">
        <div>
          <strong>{t("startup.tray.login")}</strong>
          <span>{t("startup.tray.notProtection")}</span>
        </div>
        {trayLoading || trayError || !tray
          ? <span className="badge badge-amber">{t(trayLoading ? "startup.tray.loading" : "startup.tray.unavailable")}</span>
          : <StartupStateBadge
            ok={tray.running && !tray.stale}
            yes={t("startup.tray.running")}
            no={t(tray.stale ? "startup.tray.stale" : tray.installed ? "startup.tray.stopped" : "startup.tray.notInstalled")}
          />}
      </div>
      <div className="startup-tray-buttons">
        {!trayLoading && !trayError && tray && !tray.installed && !tray.stale && (
          <button type="button" className="btn btn-primary" disabled={trayBusy} onClick={() => onTrayAction("install")}>{t("startup.tray.install")}</button>
        )}
        {!trayLoading && !trayError && tray?.installed && !tray.stale && !tray.running && (
          <button type="button" className="btn btn-primary" disabled={trayBusy} onClick={() => onTrayAction("start")}>{t("startup.tray.start")}</button>
        )}
        {!trayLoading && !trayError && tray?.running && !tray.stale && (
          <button type="button" className="btn btn-ghost" disabled={trayBusy} onClick={() => onTrayAction("stop")}>{t("startup.tray.stop")}</button>
        )}
        {!trayLoading && !trayError && tray && (tray.installed || tray.stale) && (
          <button type="button" className="btn btn-danger" disabled={trayBusy} onClick={() => {
            if (window.confirm(t("startup.tray.uninstall"))) onTrayAction("uninstall");
          }}>{t("startup.tray.uninstall")}</button>
        )}
      </div>
      {(trayError || tray?.stale) && (
        <div className="notice notice-warn startup-tray-error" role="alert">{t("startup.tray.error")}</div>
      )}
    </section>
  );
}

export function StartupAdvancedSection({
  data,
  failed,
  loading = false,
  installBusy,
  onInstall,
  copied,
  onCopy,
  defaultOpen,
}: {
  data: StartupHealthData;
  failed: boolean;
  loading?: boolean;
  installBusy: StartupInstallAction | null;
  onInstall: (action: StartupInstallAction, opts?: { repair?: boolean }) => void;
  copied: string | null;
  onCopy: (command: string) => void;
  defaultOpen: boolean;
}) {
  const { t } = useI18n();
  // At-risk (or stale) opens Advanced so the repair affordances stay visible. The
  // user's explicit toggle wins over the derived default afterwards.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? defaultOpen;

  // An already-registered service is refreshed in place. `install` re-registers, which
  // needs elevation on Windows and can switch a WinSW backend to Task Scheduler, so
  // handing that command to someone who already has a service costs them a UAC prompt
  // they do not need. A conflict still needs uninstall-then-install.
  const serviceCommand = data.serviceInstalled && !data.serviceConflict
    ? data.commands.repairService
    : data.commands.installService;
  // Repair only rewrites stale assets — conflict/disabled need uninstall/reinstall, not repair.
  const serviceNeedsRepair = data.serviceSupported && data.serviceInstalled && data.serviceStale && !data.serviceConflict;
  const shimNeedsRepair = data.shimInstalled && !data.shimHealthy;
  const actionsDisabled = installBusy !== null || failed || loading;

  return (
    <section className="panel startup-advanced">
      <button
        type="button"
        className="startup-advanced-toggle"
        aria-expanded={open}
        aria-controls="startup-advanced-panel"
        onClick={() => setOverride(!open)}
      >
        <span className="startup-advanced-title">{t("startup.advanced.title")}</span>
        <IconChevron aria-hidden="true" className={`startup-advanced-chevron${open ? " startup-advanced-chevron--open" : ""}`} />
      </button>
      <div id="startup-advanced-panel" hidden={!open}>
        <p className="muted startup-advanced-hint">{t("startup.advanced.hint")}</p>
        <h4 className="startup-advanced-subhead">
          {t("startup.details")}
          <span className="muted mono">{data.platform}</span>
        </h4>
        <div className="startup-detail-row">
          <div><strong>{t("startup.service")}</strong><span>{t("startup.serviceHint")}</span></div>
          <div className="startup-detail-actions">
            <StartupStateBadge
              ok={data.serviceViable}
              yes={t("startup.viable")}
              no={t(data.serviceConflict ? "startup.conflict" : data.serviceStale ? "startup.stale" : data.serviceInstalled ? "startup.unhealthy" : data.serviceSupported ? "startup.notInstalled" : "startup.unsupported")}
            />
            {data.serviceSupported && !data.serviceInstalled && (
              <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.service")} - ${t("startup.install")}`} disabled={actionsDisabled} onClick={() => onInstall("install-service")}>
                {t(installBusy === "install-service" ? "startup.installing" : "startup.install")}
              </button>
            )}
            {serviceNeedsRepair && (
              <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.service")} - ${t("startup.repair")}`} disabled={actionsDisabled} onClick={() => onInstall("install-service", { repair: true })}>
                {t(installBusy === "install-service" ? "startup.repairing" : "startup.repair")}
              </button>
            )}
          </div>
        </div>
        <div className="startup-detail-row">
          <div><strong>{t("startup.shim")}</strong><span>{t("startup.shimHint")}</span></div>
          <div className="startup-detail-actions">
            <StartupStateBadge
              ok={data.shimHealthy && data.autostartEnabled}
              yes={t(data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy")}
              no={t(data.shimInstalled
                ? data.shimHealthy && !data.autostartEnabled ? "startup.installedDisabled" : "startup.stale"
                : "startup.notInstalled")}
            />
            {!data.shimInstalled && (
              <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.shim")} - ${t("startup.install")}`} disabled={actionsDisabled} onClick={() => onInstall("install-shim")}>
                {t(installBusy === "install-shim" ? "startup.installing" : "startup.install")}
              </button>
            )}
            {shimNeedsRepair && (
              <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.shim")} - ${t("startup.repair")}`} disabled={actionsDisabled} onClick={() => onInstall("install-shim", { repair: true })}>
                {t(installBusy === "install-shim" ? "startup.repairing" : "startup.repair")}
              </button>
            )}
          </div>
        </div>
        <h4 className="startup-advanced-subhead">{t("startup.recovery")}</h4>
        <p className="muted startup-advanced-hint">{t("startup.recoveryHint")}</p>
        <div className="startup-command-list">
          {data.serviceSupported && (
            <div className="startup-command-row">
              <div>
                <strong>{t("startup.command.service")}</strong>
                <code>{serviceCommand}</code>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(serviceCommand)}>
                {copied === serviceCommand ? t("startup.copied") : t("startup.copy")}
              </button>
            </div>
          )}
          <div className="startup-command-row">
            <div>
              <strong>{t("startup.command.shim")}</strong>
              <code>{data.commands.installShim}</code>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(data.commands.installShim)}>
              {copied === data.commands.installShim ? t("startup.copied") : t("startup.copy")}
            </button>
          </div>
          <div className="startup-command-row">
            <div>
              <strong>{t("startup.command.native")}</strong>
              <code>{data.commands.restoreNative}</code>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(data.commands.restoreNative)}>
              {copied === data.commands.restoreNative ? t("startup.copied") : t("startup.copy")}
            </button>
          </div>
        </div>
        {data.status === "at-risk" && (
          <div className="notice notice-warn startup-action-notice" role="alert">
            <IconPower /> {t("startup.recommended", { cmd: data.recommendedCommand ?? data.commands.installService })}
          </div>
        )}
      </div>
    </section>
  );
}
