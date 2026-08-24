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
  const [previewApply, setPreviewApply] = useState(false);
  const [success, setSuccess] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const previewConfirmRef = useRef<HTMLButtonElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const copyFeedback = useCopyFeedback<CodexDelegationStatus["copyPrompts"][keyof CodexDelegationStatus["copyPrompts"]]>();
  const blocked = status?.state === "conflict" || status?.state === "unsafe";
  const canMutate = loaded && !!status && !blocked && !busy;
  const installed = status?.state === "current";
  const primaryKey = status?.state === "update-available" ? "sub.delegationSetup.update"
    : status?.state === "partial" ? "sub.delegationSetup.repair" : "sub.delegationSetup.install";
  const prompt = status?.copyPrompts[selectedMode] ?? "";
  const copyOutcome = copyFeedback.outcomeFor(prompt);

  const closePreview = () => { setPreviewOpen(false); setPreviewApply(false); setTimeout(() => openerRef.current?.focus(), 0); };
  const closeRemove = () => { setRemoveOpen(false); setTimeout(() => removeTriggerRef.current?.focus(), 0); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (previewOpen) { event.preventDefault(); closePreview(); }
      if (removeOpen) { event.preventDefault(); closeRemove(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => { if (previewOpen) setTimeout(() => (previewApply ? previewConfirmRef.current : document.querySelector<HTMLButtonElement>(".swi-delegation-dialog button"))?.focus(), 0); }, [previewApply, previewOpen]);
  const trap = (event: React.KeyboardEvent<HTMLDivElement>) => { if (event.key !== "Tab") return; const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")); if (!buttons.length) return; const first = buttons[0]!; const last = buttons.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } };
  const openPreview = (event: React.MouseEvent<HTMLButtonElement>, apply: boolean) => { openerRef.current = event.currentTarget; setPreviewApply(apply); setPreviewOpen(true); };
  const runInstall = async () => { if (await install()) { setSuccess(true); closePreview(); } };
  const runRemove = async () => { if (await uninstall()) { setSuccess(true); closeRemove(); } };

  if (!loaded) return <section className="subagents-command-card swi-delegation-setup" aria-busy="true"><div className="swi-card-head"><h2 className="swi-card-title">{t("sub.delegationSetup.loading")}</h2></div></section>;

  return (
    <section className="subagents-command-card swi-delegation-setup" aria-labelledby="codex-delegation-setup-title" aria-busy={busy}>
      <div className="swi-card-head">
        <div><h2 id="codex-delegation-setup-title" className="swi-card-title">{t("sub.delegationSetup.title")}</h2><p className="swi-card-subtitle">{t("sub.delegationSetup.subtitle")}</p></div>
        {status && <span className={`swi-delegation-badge swi-delegation-badge--${status.state}`}>{t(statusKey(status))}</span>}
      </div>
      {!status && <div className="swi-delegation-body"><p className="swi-delegation-error" role="alert">{t("sub.delegationSetup.error")}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => { void delegationSetup.reload(); }}>{t("sub.delegationSetup.retry")}</button></div>}
      {status && <div className="swi-delegation-body">
        <fieldset className="swi-delegation-modes" disabled={busy}>
          <legend className="sr-only">{t("sub.delegationSetup.modeLegend")}</legend>
          {(["balanced", "orchestrator"] as const).map(mode => <label className={`swi-delegation-mode${selectedMode === mode ? " is-selected" : ""}`} key={mode}>
            <input type="radio" name="codex-delegation-mode" value={mode} checked={selectedMode === mode} onChange={() => setSelectedMode(mode)} />
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
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={event => openPreview(event, false)}>{t("sub.delegationSetup.preview")}</button>
          {!installed && <button type="button" className="btn btn-primary btn-sm" disabled={!canMutate} onClick={event => openPreview(event, true)}>{t(primaryKey)}</button>}
          {installed && <button type="button" className="btn btn-ghost btn-sm" disabled={!canMutate} onClick={event => openPreview(event, true)}>{t("sub.delegationSetup.changeMode")}</button>}
          {installed && <button ref={removeTriggerRef} type="button" className="btn btn-ghost btn-sm swi-delegation-remove" disabled={!canMutate} onClick={() => setRemoveOpen(true)}>{t("sub.delegationSetup.remove")}</button>}
        </div>
        {busy && <p className="swi-delegation-working" aria-live="polite">{t("sub.delegationSetup.working")}</p>}
        {success && <p className="swi-delegation-working" role="status">{t("sub.delegationSetup.newTask")}</p>}
        <details className="swi-delegation-manual"><summary>{t("sub.delegationSetup.manual")}</summary><div><p>{t("sub.delegationSetup.manualHint")}</p><button type="button" className="btn btn-ghost btn-sm" disabled={!prompt} onClick={() => copyFeedback.copy(prompt, prompt)}>{t(copyOutcome === "copied" ? "sub.delegationSetup.copied" : copyOutcome === "unavailable" ? "sub.delegationSetup.copyUnavailable" : "sub.delegationSetup.copy")}</button></div></details>
      </div>}
      {previewOpen && status && <div className="dialog-backdrop" onMouseDown={closePreview}><div className="dialog swi-delegation-dialog" role="dialog" aria-modal="true" aria-labelledby="delegation-preview-title" aria-describedby="delegation-preview-copy" onKeyDown={trap} onMouseDown={event => event.stopPropagation()}><h3 id="delegation-preview-title">{t("sub.delegationSetup.preview")}</h3><div id="delegation-preview-copy"><pre>{status.previews[selectedMode].skillText}</pre><pre>{status.previews[selectedMode].agentsBlockText}</pre></div><div className="swi-delegation-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={closePreview}>{t("sub.delegationSetup.close")}</button>{previewApply && <button ref={previewConfirmRef} type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void runInstall(); }}>{t(primaryKey)}</button>}</div></div></div>}
      {removeOpen && <div className="dialog-backdrop" onMouseDown={closeRemove}><div className="dialog swi-delegation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delegation-remove-title" aria-describedby="delegation-remove-copy" onKeyDown={trap} onMouseDown={event => event.stopPropagation()}><h3 id="delegation-remove-title">{t("sub.delegationSetup.removeTitle")}</h3><p id="delegation-remove-copy">{t("sub.delegationSetup.removeConfirm")}</p><div className="swi-delegation-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={closeRemove}>{t("sub.delegationSetup.cancel")}</button><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void runRemove(); }}>{t("sub.delegationSetup.remove")}</button></div></div></div>}
    </section>
  );
}
