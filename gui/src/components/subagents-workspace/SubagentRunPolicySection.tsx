import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconChevron, IconInfo, IconX } from "../../icons";
import { type TKey, useT } from "../../i18n/shared";
import { formatNamespacedModelId } from "../../provider-icons";
import { Notice, Select, Switch } from "../../ui";
import type { DelegationModelOption, DelegationPatch } from "../../pages/use-subagent-delegation";
import type { MultiAgentMode, MultiAgentV2MessageDelivery, SubagentRunPolicy } from "../../pages/use-subagent-run-policy";

type DelegationState = {
  loaded: boolean;
  saving: boolean;
  error: string | null;
  model: string;
  effort: string;
  efforts: string[];
  available: DelegationModelOption[];
  guidanceEnabled: boolean;
  syncCodexDefaults: boolean;
  onSave: (patch: DelegationPatch) => Promise<boolean>;
  onReload: () => Promise<boolean>;
};

type DelegationDraft = Pick<DelegationState, "model" | "effort" | "guidanceEnabled" | "syncCodexDefaults">;

function sameDelegation(a: DelegationDraft, b: DelegationDraft): boolean {
  return a.model === b.model
    && a.effort === b.effort
    && a.guidanceEnabled === b.guidanceEnabled
    && a.syncCodexDefaults === b.syncCodexDefaults;
}

function moveValue(values: string[], index: number, direction: -1 | 1): string[] {
  const destination = index + direction;
  if (destination < 0 || destination >= values.length) return values;
  const next = [...values];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

function modelOptions(values: string[], t: ReturnType<typeof useT>) {
  return values.map(value => ({ value, label: formatNamespacedModelId(value, t) }));
}

export default function SubagentRunPolicySection({
  policy,
  delegation,
}: {
  policy: SubagentRunPolicy;
  delegation: DelegationState;
}) {
  const t = useT();
  const committedDelegation = useMemo<DelegationDraft>(() => ({
    model: delegation.model,
    effort: delegation.effort,
    guidanceEnabled: delegation.guidanceEnabled,
    syncCodexDefaults: delegation.syncCodexDefaults,
  }), [delegation.guidanceEnabled, delegation.model, delegation.effort, delegation.syncCodexDefaults]);
  const [draft, setDraft] = useState<DelegationDraft>(committedDelegation);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const [localSaving, setLocalSaving] = useState(false);
  const [fallbackToAdd, setFallbackToAdd] = useState("");
  const priorCommittedRef = useRef(committedDelegation);
  const adoptNextCommitRef = useRef(false);
  const saveInFlightRef = useRef(false);

  useEffect(() => {
    if (!delegation.loaded) return;
    const previous = priorCommittedRef.current;
    const draftWasClean = sameDelegation(draft, previous);
    priorCommittedRef.current = committedDelegation;
    if (draftWasClean || adoptNextCommitRef.current) {
      adoptNextCommitRef.current = false;
      setDraft(committedDelegation);
    }
  }, [committedDelegation, delegation.loaded, draft]);

  const delegationDirty = delegation.loaded && !sameDelegation(draft, committedDelegation);
  const dirty = policy.dirty || delegationDirty;
  const unavailable = !policy.loaded || !delegation.loaded;
  const saving = localSaving || policy.saving || delegation.saving;
  const firstFallback = policy.fallbackModels[0] ?? "";
  const fallbackChoices = useMemo(() => {
    const unique = new Set([...policy.fallbackModels, ...policy.fallbackAvailable]);
    return [...unique];
  }, [policy.fallbackAvailable, policy.fallbackModels]);
  const delegationChoices = useMemo(() => {
    const selectors = new Set(delegation.available.map(option => option.namespaced));
    if (delegation.model) selectors.add(delegation.model);
    return [...selectors].map(value => ({ value, label: formatNamespacedModelId(value, t) }));
  }, [delegation.available, delegation.model, t]);
  const addableFallbacks = useMemo(() => {
    const selectedFallbacks = new Set(policy.fallbackModels);
    return fallbackChoices.filter(model => !selectedFallbacks.has(model));
  }, [fallbackChoices, policy.fallbackModels]);

  const updateDraft = (patch: Partial<DelegationDraft>) => {
    setFeedback(null);
    setDraft(previous => ({ ...previous, ...patch }));
  };

  const save = async () => {
    if (!dirty || unavailable || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setLocalSaving(true);
    setFeedback(null);

    const patch: DelegationPatch = {};
    if (draft.model !== committedDelegation.model || draft.effort !== committedDelegation.effort) {
      patch.model = draft.model || null;
      patch.effort = draft.effort || null;
    }
    if (draft.guidanceEnabled !== committedDelegation.guidanceEnabled) {
      patch.multiAgentGuidanceEnabled = draft.guidanceEnabled;
    }
    if (draft.syncCodexDefaults !== committedDelegation.syncCodexDefaults) {
      patch.syncCodexSubagentDefaults = draft.syncCodexDefaults;
    }

    const [policyOk, delegationOk] = await Promise.all([
      policy.dirty ? policy.save() : Promise.resolve(true),
      Object.keys(patch).length > 0 ? delegation.onSave(patch) : Promise.resolve(true),
    ]);
    if (delegationOk) adoptNextCommitRef.current = true;
    setFeedback(policyOk && delegationOk ? "saved" : "failed");
    saveInFlightRef.current = false;
    setLocalSaving(false);
  };

  const retry = async () => {
    setFeedback(null);
    await Promise.all([policy.reload(), delegation.onReload()]);
  };

  const modeOptions = (["v1", "default", "v2"] as MultiAgentMode[]).map(mode => ({
    value: mode,
    label: t(`models.modeLabel_${mode}` as TKey),
  }));
  const messageDeliveryOptions = (["encrypted", "plaintext"] as MultiAgentV2MessageDelivery[]).map(delivery => ({
    value: delivery,
    label: t(`sub.policy.messageDelivery_${delivery}` as TKey),
  }));
  const pollOptions = [
    { value: "15000", label: t("sub.policy.seconds", { n: 15 }) },
    { value: "30000", label: t("sub.policy.seconds", { n: 30 }) },
    { value: "60000", label: t("sub.policy.minute") },
    { value: "120000", label: t("sub.policy.minutes", { n: 2 }) },
    { value: "300000", label: t("sub.policy.minutes", { n: 5 }) },
    { value: "600000", label: t("sub.policy.minutes", { n: 10 }) },
  ];

  if (unavailable && (policy.loading || !delegation.loaded)) {
    return <div className="swi-policy-loading" aria-busy="true">{t("sub.policy.loading")}</div>;
  }

  if (unavailable) {
    return (
      <div className="swi-policy-load-error">
        <Notice tone="err">{policy.error || delegation.error || t("sub.policy.saveFailed")}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void retry(); }}>{t("sub.policy.retry")}</button>
      </div>
    );
  }

  return (
    <div className="swi-policy-body">
      {(policy.error || delegation.error) && <Notice tone="err">{policy.error || delegation.error}</Notice>}
      {feedback === "saved" && <Notice tone="ok">{t("sub.policy.saved")}</Notice>}
      {feedback === "failed" && !policy.error && !delegation.error && <Notice tone="err">{t("sub.policy.saveFailed")}</Notice>}
      {policy.mode === "v2" && <Notice tone="warn">{t(
        policy.messageDelivery === "plaintext"
          ? "sub.policy.compatibilityV2Plaintext"
          : "sub.policy.compatibilityV2",
      )}</Notice>}

      <div className="swi-policy-grid">
        <div className="swi-policy-field">
          <label className="swi-policy-label" htmlFor="subagent-policy-mode">{t("sub.policy.mode")}</label>
          <Select
            id="subagent-policy-mode"
            value={policy.mode}
            options={modeOptions}
            onChange={value => { setFeedback(null); policy.setMode(value as MultiAgentMode); }}
            disabled={saving}
            label={t("sub.policy.mode")}
            style={{ width: "100%" }}
          />
          <span className="swi-policy-help">{t(`models.modeOptionDesc_${policy.mode}` as TKey)}</span>
        </div>

        <div className="swi-policy-field">
          <label className="swi-policy-label" htmlFor="subagent-policy-message-delivery">{t("sub.policy.messageDelivery")}</label>
          <Select
            id="subagent-policy-message-delivery"
            value={policy.messageDelivery}
            options={messageDeliveryOptions}
            onChange={value => {
              setFeedback(null);
              policy.setMessageDelivery(value as MultiAgentV2MessageDelivery);
            }}
            disabled={saving}
            label={t("sub.policy.messageDelivery")}
            style={{ width: "100%" }}
          />
          <span className="swi-policy-help">{t(`sub.policy.messageDeliveryHint_${policy.messageDelivery}` as TKey)}</span>
        </div>

        <div className="swi-policy-field">
          <label className="swi-policy-label" htmlFor="subagent-policy-preferred">{t("sub.policy.preferred")}</label>
          <Select
            id="subagent-policy-preferred"
            value={draft.model}
            options={[{ value: "", label: t("sub.policy.noPreferred") }, ...delegationChoices]}
            onChange={model => updateDraft({
              model,
              effort: "",
              ...(model ? {} : { syncCodexDefaults: false }),
            })}
            disabled={saving}
            label={t("sub.policy.preferred")}
            style={{ width: "100%" }}
          />
          <span className="swi-policy-help">{t("sub.delegation.modelHint")}</span>
        </div>

        <div className="swi-policy-field">
          <label className="swi-policy-label" htmlFor="subagent-policy-fallback">{t("sub.policy.fallback")}</label>
          <Select
            id="subagent-policy-fallback"
            value={firstFallback}
            options={[{ value: "", label: t("sub.policy.noFallback") }, ...modelOptions(fallbackChoices, t)]}
            onChange={model => {
              setFeedback(null);
              policy.setFallbackModels(model
                ? [model, ...policy.fallbackModels.filter(value => value !== model)]
                : []);
            }}
            disabled={saving}
            label={t("sub.policy.fallback")}
            style={{ width: "100%" }}
          />
          <span className="swi-policy-help">{t("sub.policy.fallbackHint")}</span>
        </div>

        <div className="swi-policy-field">
          <label className="swi-policy-label" htmlFor="subagent-policy-concurrency">{t("sub.policy.concurrency")}</label>
          <div className="swi-concurrency-control">
            <input
              id="subagent-policy-concurrency"
              type="number"
              min={1}
              step={1}
              value={policy.concurrency ?? ""}
              placeholder={t("sub.policy.codexDefault")}
              onChange={event => {
                setFeedback(null);
                const raw = event.target.value.trim();
                policy.setConcurrency(raw === "" ? null : Number(raw));
              }}
              disabled={saving}
              aria-label={t("sub.policy.concurrency")}
            />
            <span className="swi-concurrency-buttons">
              <button
                type="button"
                disabled={saving || policy.concurrency === null || policy.concurrency <= 1}
                onClick={() => policy.setConcurrency(Math.max(1, (policy.concurrency ?? 4) - 1))}
                aria-label={t("sub.policy.decreaseConcurrency")}
              ><IconArrowDown aria-hidden="true" /></button>
              <button
                type="button"
                disabled={saving}
                onClick={() => policy.setConcurrency((policy.concurrency ?? 4) + 1)}
                aria-label={t("sub.policy.increaseConcurrency")}
              ><IconArrowUp aria-hidden="true" /></button>
            </span>
          </div>
          <span className="swi-policy-help">{t("sub.policy.concurrencyHint")}</span>
        </div>

        <div className="swi-policy-field swi-policy-guidance-field">
          <div className="swi-policy-label">{t("sub.policy.guidance")}</div>
          <div className="swi-policy-toggle-row">
            <span className="swi-policy-help">{t("sub.policy.guidanceHint")}</span>
            <Switch
              on={draft.guidanceEnabled}
              onClick={() => updateDraft({ guidanceEnabled: !draft.guidanceEnabled })}
              disabled={saving}
              label={t("sub.policy.guidance")}
            />
          </div>
        </div>

        <div className="swi-policy-save-cell">
          <button type="button" className="btn btn-primary" onClick={() => { void save(); }} disabled={!dirty || saving}>
            {saving ? t("sub.saving") : t("sub.policy.save")}
          </button>
        </div>
      </div>

      <details className="swi-policy-details">
        <summary><IconChevron aria-hidden="true" /><span>{t("sub.policy.details")}</span></summary>
        <div className="swi-policy-details-grid">
          <div className="swi-policy-detail-group">
            <div>
              <div className="swi-policy-label">{t("sub.policy.fallbackChain")}</div>
              <div className="swi-policy-help">{t("sub.policy.fallbackChainHint")}</div>
            </div>
            {policy.fallbackModels.length === 0 ? (
              <div className="swi-fallback-empty">{t("sub.policy.noFallback")}</div>
            ) : (
              <ol className="swi-fallback-chain">
                {policy.fallbackModels.map((model, index) => (
                  <li key={model}>
                    <span className="swi-fallback-rank">{index + 1}</span>
                    <span className="swi-fallback-name">{formatNamespacedModelId(model, t)}</span>
                    <span className="swi-fallback-actions">
                      <button type="button" disabled={saving || index === 0} onClick={() => policy.setFallbackModels(moveValue(policy.fallbackModels, index, -1))} aria-label={t("sub.moveUp", { m: model })}><IconArrowUp aria-hidden="true" /></button>
                      <button type="button" disabled={saving || index === policy.fallbackModels.length - 1} onClick={() => policy.setFallbackModels(moveValue(policy.fallbackModels, index, 1))} aria-label={t("sub.moveDown", { m: model })}><IconArrowDown aria-hidden="true" /></button>
                      <button type="button" disabled={saving} onClick={() => policy.setFallbackModels(policy.fallbackModels.filter(value => value !== model))} aria-label={t("sub.policy.removeFallback", { m: model })}><IconX aria-hidden="true" /></button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {addableFallbacks.length > 0 && (
              <div className="swi-add-fallback">
                <Select
                  value={fallbackToAdd}
                  options={[{ value: "", label: t("sub.policy.addFallback") }, ...modelOptions(addableFallbacks, t)]}
                  onChange={model => {
                    if (!model) return;
                    policy.setFallbackModels([...policy.fallbackModels, model]);
                    setFallbackToAdd("");
                    setFeedback(null);
                  }}
                  disabled={saving}
                  label={t("sub.policy.addFallback")}
                />
              </div>
            )}
          </div>

          <div className="swi-policy-detail-group swi-policy-safeguards">
            <div className="swi-policy-mini-field">
              <div>
                <div className="swi-policy-label">{t("sub.policy.poll")}</div>
                <div className="swi-policy-help">{t("sub.policy.pollHint")}</div>
              </div>
              <Select
                value={String(policy.pollMs)}
                options={pollOptions}
                onChange={value => { setFeedback(null); policy.setPollMs(Number(value)); }}
                disabled={saving}
                label={t("sub.policy.poll")}
              />
            </div>

            <div className="swi-policy-mini-field">
              <div>
                <div className="swi-policy-label">{t("sub.policy.preferredEffort")}</div>
                <div className="swi-policy-help">{t("sub.policy.preferredEffortHint")}</div>
              </div>
              <Select
                value={draft.effort}
                options={[
                  { value: "", label: t("dash.injectionEffortNone") },
                  ...delegation.efforts.map(value => ({ value, label: value })),
                ]}
                onChange={effort => updateDraft({ effort })}
                disabled={saving || !draft.model}
                label={t("sub.policy.preferredEffort")}
              />
            </div>

            <div className="swi-policy-mini-field">
              <div>
                <div className="swi-policy-label">{t("sub.policy.subagentCap")}</div>
                <div className="swi-policy-help">{t("sub.policy.subagentCapHint")}</div>
              </div>
              <Select
                value={policy.subagentEffortCap ?? ""}
                options={[
                  { value: "", label: t("dash.effortCapNone") },
                  ...policy.efforts.map(value => ({ value, label: value })),
                ]}
                onChange={value => { setFeedback(null); policy.setSubagentEffortCap(value || null); }}
                disabled={saving}
                label={t("sub.policy.subagentCap")}
              />
            </div>

            <div className="swi-policy-mini-field swi-policy-toggle-field">
              <div>
                <div className="swi-policy-label">{t("dash.syncCodexSubagentDefaults")}</div>
                <div className="swi-policy-help">{t("dash.syncCodexSubagentDefaultsHint")}</div>
              </div>
              <Switch
                on={draft.syncCodexDefaults}
                onClick={() => updateDraft({ syncCodexDefaults: !draft.syncCodexDefaults })}
                disabled={saving || !draft.model}
                label={t("dash.syncCodexSubagentDefaults")}
              />
            </div>
          </div>
        </div>
        <div className="swi-policy-detail-note"><IconInfo aria-hidden="true" />{t("sub.policy.timing")}</div>
      </details>
    </div>
  );
}
