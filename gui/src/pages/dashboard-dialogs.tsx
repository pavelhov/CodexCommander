import { IconX } from "../icons";
import type { useDashboardData } from "./use-dashboard-data";
import { shadowSourceModelLabel } from "./shadow-call-source";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardDialogs(d: Dash) {
  const {
    t,
    maHelpOpen, setMaHelpOpen, maHelpDialogRef,
    effortCapHelpOpen, setEffortCapHelpOpen, effortCapHelpDialogRef,
    shadowCallHelpOpen, setShadowCallHelpOpen, shadowCallHelpDialogRef,
    shadowCall,
  } = d;

  return (
    <>
      <dialog
        ref={maHelpDialogRef}
        id="multi-agent-help-dialog"
        className="modal-overlay"
        style={{ display: maHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="multi-agent-help-title"
        onCancel={event => { event.preventDefault(); setMaHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setMaHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="multi-agent-help-title">{t("dash.multiAgent")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setMaHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("models.v2Help")}
          </div>
          <div style={{ marginTop: 12 }}>
            <a className="text-control" href="https://github.com/pavelhov/CodexCommander/blob/main/docs-site/src/content/docs/guides/sub-agent-surface.md" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {t("models.v2DocsLink")}
            </a>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setMaHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={effortCapHelpDialogRef}
        id="effort-cap-help-dialog"
        className="modal-overlay"
        style={{ display: effortCapHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="effort-cap-help-title"
        onCancel={event => { event.preventDefault(); setEffortCapHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setEffortCapHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="effort-cap-help-title">{t("dash.effortCapLabel")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEffortCapHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("dash.effortCapHelp")}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setEffortCapHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={shadowCallHelpDialogRef}
        id="shadow-call-help-dialog"
        className="modal-overlay"
        style={{ display: shadowCallHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="shadow-call-help-title"
        onCancel={event => { event.preventDefault(); setShadowCallHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setShadowCallHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="shadow-call-help-title">{t("dash.shadowCallIntercept")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShadowCallHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("dash.shadowCallTooltip", { models: shadowSourceModelLabel(shadowCall?.sourceModels) })}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setShadowCallHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
