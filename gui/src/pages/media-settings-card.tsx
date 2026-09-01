import { useEffect, useRef, useState } from "react";

import { setClientResourceData, useKeyedClientResource } from "../client-resource";
import { IconAlert, IconCheck } from "../icons";
import { useT } from "../i18n/shared";
import { Select } from "../ui";
import {
  fetchDashboardMedia,
  mediaResourceKey,
  type DashboardMediaResource,
  type MediaSource,
} from "./media-settings-resource";
import { requireJson } from "./dashboard-shared";

function sourceCopyKey(source: MediaSource | null, ready: boolean) {
  if (ready) return "dash.media.ready" as const;
  return source === "api_key" ? "dash.media.recoverApiKey" as const : "dash.media.recoverOauth" as const;
}

export function MediaSettingsCard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const key = mediaResourceKey(apiBase);
  const poll = useKeyedClientResource(key, [apiBase], signal => fetchDashboardMedia(apiBase, signal), { pollMs: 5_000 });
  const resource = poll.data;
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (feedback?.kind === "error") errorRef.current?.focus();
  }, [feedback]);

  async function save(patch: Partial<DashboardMediaResource["settings"]>) {
    if (!resource || saving) return;
    const previous = resource;
    const optimistic = { ...resource, settings: { ...resource.settings, ...patch } };
    setSaving(true);
    setFeedback(null);
    setClientResourceData(key, optimistic);
    try {
      const response = await fetch(`${apiBase}/api/media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: resource.revision, ...patch }),
      });
      if (response.status === 409) {
        try {
          const winner = await fetchDashboardMedia(apiBase);
          setClientResourceData(key, winner);
        } catch {
          setClientResourceData(key, previous);
        }
        setFeedback({ kind: "error", text: t("dash.media.saveFailed") });
        return;
      }
      const next = await requireJson<DashboardMediaResource>(response, "media save failed");
      setClientResourceData(key, next);
      setFeedback({ kind: "ok", text: t("dash.media.saved") });
    } catch {
      setClientResourceData(key, previous);
      setFeedback({ kind: "error", text: t("dash.media.saveFailed") });
    } finally {
      setSaving(false);
    }
  }

  async function action(input: Record<string, unknown>, confirmation: string) {
    if (!resource || actionId || !window.confirm(confirmation)) return;
    const id = typeof input.id === "string" ? input.id : "media";
    setActionId(id);
    setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/media/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmation: true, caller: "confirmed_gui" }),
      });
      await requireJson(response, "media action failed");
      await poll.refresh();
      setFeedback({ kind: "ok", text: t("dash.media.actionApplied") });
    } catch {
      setFeedback({ kind: "error", text: t("dash.media.actionFailed") });
    } finally {
      setActionId(null);
    }
  }

  const source = resource?.settings.authSource ?? null;
  const credentialReady = resource?.readiness.credential.state === "ready";
  return (
    <section className="panel" aria-busy={!resource || saving || undefined} aria-labelledby="dashboard-media-title">
      <div className="spread" style={{ alignItems: "start", gap: 16 }}>
        <div>
          <div id="dashboard-media-title" className="font-semibold">{t("dash.media.title")}</div>
          <div className="muted setting-hint">{t("dash.media.experimental")}</div>
        </div>
        <Select
          value={source ?? ""}
          options={[
            { value: "", label: t("dash.media.sourceChoose") },
            { value: "subscription_oauth", label: t("dash.media.sourceOauth") },
            { value: "api_key", label: t("dash.media.sourceApiKey") },
          ]}
          onChange={value => {
            if (value === "subscription_oauth" || value === "api_key") void save({ authSource: value });
          }}
          disabled={!resource || saving}
          label={t("dash.media.source")}
          align="right"
        />
      </div>

      <div className="dash-sidecar-grid" style={{ marginTop: 14 }}>
        <div className="dash-sidecar-card__row">
          <div>
            <div className="font-semibold">{t("dash.media.images")}</div>
            <div className="muted setting-hint">{t("dash.media.imagesHint")}</div>
          </div>
          <button
            type="button"
            className={`switch ${resource?.settings.imagesEnabled ? "on" : ""}`}
            aria-label={t("dash.media.images")}
            aria-pressed={resource?.settings.imagesEnabled ?? false}
            disabled={!resource || saving || source === null}
            onClick={() => { void save({ imagesEnabled: !resource?.settings.imagesEnabled }); }}
          ><span className="knob" /></button>
        </div>
        <div className="dash-sidecar-card__row">
          <div>
            <div className="font-semibold">{t("dash.media.videos")}</div>
            <div className="muted setting-hint">{t("dash.media.videosHint")}</div>
          </div>
          <button
            type="button"
            className={`switch ${resource?.settings.videosEnabled ? "on" : ""}`}
            aria-label={t("dash.media.videos")}
            aria-pressed={resource?.settings.videosEnabled ?? false}
            disabled={!resource || saving || source === null}
            onClick={() => { void save({ videosEnabled: !resource?.settings.videosEnabled }); }}
          ><span className="knob" /></button>
        </div>
      </div>

      {resource && (
        <div className={`notice ${credentialReady ? "notice-ok" : "notice-warn"}`} role="status" style={{ marginTop: 12 }}>
          {credentialReady ? <IconCheck /> : <IconAlert />}
          <span>{t(sourceCopyKey(source, credentialReady))} {t("dash.media.noFallback")}</span>
        </div>
      )}

      {resource?.probe && (
        <div className="spread" style={{ marginTop: 12, gap: 12 }}>
          <div className="muted text-control">
            {t("dash.media.probeStatus", { image: resource.probe.steps.image.state, video: resource.probe.steps.video.state })}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={actionId !== null || !credentialReady || source !== "subscription_oauth"}
            onClick={() => { void action({ action: "probe", target: "probe", id: resource.probe!.id, expectedRevision: resource.probe!.revision }, t("dash.media.probeConfirm")); }}
          >{t("dash.media.probe")}</button>
        </div>
      )}

      {resource?.recovery && (
        <div className="notice notice-warn" role="status" style={{ marginTop: 12 }}>
          <IconAlert /><span>{resource.recovery.action === "upgrade"
            ? t("dash.media.recoveryUpgrade")
            : resource.recovery.action === "manual_recovery"
              ? t("dash.media.recoveryManual")
              : t("dash.media.recoveryBlocked")}</span>
          {(resource.recovery.action === "quarantine_reset" || resource.recovery.action === "acknowledge") && (
            resource.recovery.action === "acknowledge"
              ? <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={actionId !== null}
                  onClick={() => { void action({ action: "acknowledge", target: "recovery", id: resource.recovery!.id, expectedRevision: resource.recovery!.revision }, t("dash.media.recoveryAckConfirm")); }}
                >{t("dash.media.recoveryAck")}</button>
              : <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={actionId !== null}
                  onClick={() => { void action({ action: "quarantine_reset", target: "recovery", id: resource.recovery!.id, expectedRevision: resource.recovery!.revision }, t("dash.media.recoveryConfirm")); }}
                >{t("dash.media.recoveryAction")}</button>
          )}
        </div>
      )}

      {!!resource?.jobs.length && (
        <div style={{ marginTop: 12 }}>
          <div className="font-semibold">{t("dash.media.jobs")}</div>
          {resource.jobs.map(job => (
            <div key={job.id} className="spread text-control" style={{ gap: 12, marginTop: 8 }}>
              <span><code>{job.id.slice(0, 8)}</code> · <code>{job.state}</code></span>
              <span style={{ display: "flex", gap: 6 }}>
                {job.action === "acknowledge" && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={actionId !== null} onClick={() => { void action({ action: "acknowledge", target: "job", id: job.id, expectedRevision: job.revision }, t("dash.media.ackConfirm")); }}>{t("dash.media.ack")}</button>
                )}
                {job.action === "open" && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={actionId !== null} onClick={() => { void action({ action: "open", target: "job", id: job.id, expectedRevision: job.revision }, t("dash.media.openConfirm")); }}>{t("dash.media.open")}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={actionId !== null} onClick={() => { void action({ action: "reveal", target: "job", id: job.id, expectedRevision: job.revision }, t("dash.media.revealConfirm")); }}>{t("dash.media.reveal")}</button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        ref={errorRef}
        tabIndex={feedback?.kind === "error" ? -1 : undefined}
        className={feedback ? `notice ${feedback.kind === "error" ? "notice-err" : "notice-ok"}` : undefined}
        role={feedback?.kind === "error" ? "alert" : "status"}
        aria-live={feedback?.kind === "error" ? "assertive" : "polite"}
        style={feedback ? { marginTop: 12 } : undefined}
      >{feedback?.text}</div>
    </section>
  );
}
