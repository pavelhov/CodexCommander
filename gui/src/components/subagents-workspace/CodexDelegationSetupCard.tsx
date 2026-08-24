import { useEffect, useRef, useState } from "react";
import { useT, type TKey } from "../../i18n/shared";
import { useCopyFeedback } from "../use-copy-feedback";
import type { CodexDelegationSetupController, CodexDelegationStatus } from "../../pages/use-codex-delegation-setup";

function statusKey(status: CodexDelegationStatus): TKey {
  if (status.state === "current" && status.activation === "effective") return "sub.delegationSetup.statusReady";
  if (status.state === "current" && status.activation === "shadowed") return "sub.delegationSetup.statusShadowed";
  const keys: Record<CodexDelegationStatus["state"], TKey> = {
    "not-installed": "sub.delegationSetup.statusNotInstalled", current: "sub.delegationSetup.statusInstalled",
    "update-available": "sub.delegationSetup.statusUpdate", partial: "sub.delegationSetup.statusPartial",
    conflict: "sub.delegationSetup.statusConflict", unsafe: "sub.delegationSetup.statusUnsafe",
  };
  return keys[status.state];
}

function blockedReason(status: CodexDelegationStatus): TKey {
  const reason = status.artifacts.skill.reason ?? status.artifacts.agentsPolicy.reason;
  return reason === "ownership_conflict" ? "sub.delegationSetup.reasonConflict" : "sub.delegationSetup.reasonUnsafe";
}

export default function CodexDelegationSetupCard({ delegationSetup }: { delegationSetup: CodexDelegationSetupController }) {
  const t = useT();
  const { loaded, status, selectedMode, busy, error, setSelectedMode, install, uninstall } = delegationSetup;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState(selectedMode);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const copyFeedback = useCopyFeedback<CodexDelegationStatus["copyPrompts"][keyof CodexDelegationStatus["copyPrompts"]]>();
  const blocked = status?.state === "conflict" || status?.state === "unsafe";
  const canMutate = loaded && !!status && !blocked && !busy;
  const installed = status?.state === "current";
  const primaryKey = status?.state === "update-available" ? "sub.delegationSetup.update"
    : status?.state === "partial" ? "sub.delegationSetup.repair" : "sub.delegationSetup.install";
  const prompt = status?.copyPrompts[previewMode] ?? "";
  const copyOutcome = copyFeedback.outcomeFor(prompt);

  const closePreview = () => { setPreviewOpen(false); setTimeout(() => previewTriggerRef.current?.focus(), 0); };
  const closeRemove = () => { setRemoveOpen(false); setTimeout(() => removeTriggerRef.current?.focus(), 0); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (previewOpen) closePreview();
      if (removeOpen) closeRemove();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!loaded) return <section className="subagents-command-card swi-delegation-setup" aria-busy="true"><div className="swi-card-head"><h2 className="swi-card-title">{t("sub.delegationSetup.loading")}</h2></div></section>;

  return (
    <section className="subagents-command-card swi-delegation-setup" aria-labelledby="codex-delegation-setup-title" aria-busy={busy}>
      <div className="swi-card-head">
        <div><h2 id="codex-delegation-setup-title" className="swi-card-title">{t("sub.delegationSetup.title")}</h2><p className="swi-card-subtitle">{t("sub.delegationSetup.subtitle")}</p></div>
        {status && <span className={`swi-delegation-badge swi-delegation-badge--${status.state}`}>{t(statusKey(status))}</span>}
      </div>
      {status && <div className="swi-delegation-body">
        <fieldset className="swi-delegation-modes" disabled={busy}>
          <legend className="sr-only">{t("sub.delegationSetup.modeLegend")}</legend>
          {(["balanced", "orchestrator"] as const).map(mode => <label className={`swi-delegation-mode${selectedMode === mode ? " is-selected" : ""}`} key={mode}>
            <input type="radio" name="codex-delegation-mode" value={mode} checked={selectedMode === mode} onChange={() => { setPreviewMode(mode); setSelectedMode(mode); }} />
            <span><strong>{t(`sub.delegationSetup.mode.${mode}` as TKey)}</strong><small>{t(`sub.delegationSetup.mode.${mode}Description` as TKey)}</small></span>
          </label>)}
        </fieldset>
        <p className="swi-delegation-note">{t("sub.delegationSetup.liveRoster")}</p>
        <ul className="swi-delegation-artifacts">
          <li><span>{t("sub.delegationSetup.skillArtifact")}</span><code>{status.artifacts.skill.displayPath}</code></li>
          <li><span>{t("sub.delegationSetup.agentsArtifact")}</span><code>{status.artifacts.agentsPolicy.displayPath}</code></li>
        </ul>
        {blocked && <p className="swi-delegation-blocked" role="alert">{t(blockedReason(status))}</p>}
        {error && <p className="swi-delegation-error" role="alert">{t("sub.delegationSetup.error")}</p>}
        <div className="swi-delegation-actions">
          <button ref={previewTriggerRef} type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPreviewOpen(true)}>{t("sub.delegationSetup.preview")}</button>
          {!installed && <button type="button" className="btn btn-primary btn-sm" disabled={!canMutate} onClick={() => { void install(); }}>{t(primaryKey)}</button>}
          {installed && <button type="button" className="btn btn-ghost btn-sm" disabled={!canMutate} onClick={() => setPreviewOpen(true)}>{t("sub.delegationSetup.changeMode")}</button>}
          {installed && <button ref={removeTriggerRef} type="button" className="btn btn-ghost btn-sm swi-delegation-remove" disabled={!canMutate} onClick={() => setRemoveOpen(true)}>{t("sub.delegationSetup.remove")}</button>}
        </div>
        {busy && <p className="swi-delegation-working" aria-live="polite">{t("sub.delegationSetup.working")}</p>}
        {!busy && installed && <p className="swi-delegation-working" role="status">{t("sub.delegationSetup.newTask")}</p>}
        <details className="swi-delegation-manual"><summary>{t("sub.delegationSetup.manual")}</summary><div><p>{t("sub.delegationSetup.manualHint")}</p><button type="button" className="btn btn-ghost btn-sm" disabled={!prompt} onClick={() => copyFeedback.copy(prompt, prompt)}>{t(copyOutcome === "copied" ? "sub.delegationSetup.copied" : copyOutcome === "unavailable" ? "sub.delegationSetup.copyUnavailable" : "sub.delegationSetup.copy")}</button></div></details>
      </div>}
      {previewOpen && status && <div className="dialog-backdrop" onMouseDown={closePreview}><div className="dialog swi-delegation-dialog" role="dialog" aria-modal="true" aria-label={t("sub.delegationSetup.preview")} onMouseDown={event => event.stopPropagation()}><pre>{status.previews[previewMode].skillText}</pre><pre>{status.previews[previewMode].agentsBlockText}</pre><button type="button" className="btn btn-ghost btn-sm" onClick={closePreview}>{t("common.close")}</button></div></div>}
      {removeOpen && <div className="dialog-backdrop" onMouseDown={closeRemove}><div className="dialog swi-delegation-dialog" role="alertdialog" aria-modal="true" aria-label={t("sub.delegationSetup.removeTitle")} onMouseDown={event => event.stopPropagation()}><p>{t("sub.delegationSetup.removeConfirm")}</p><div className="swi-delegation-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={closeRemove}>{t("common.cancel")}</button><button type="button" className="btn btn-primary btn-sm" onClick={() => { closeRemove(); void uninstall(); }}>{t("sub.delegationSetup.remove")}</button></div></div></div>}
    </section>
  );
}
