import { useMemo, useRef, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconGrip,
  IconInfo,
  IconPlus,
  IconSearch,
  IconX,
} from "../../icons";
import { useI18n, useT, type Locale, type TFn } from "../../i18n/shared";
import { Notice } from "../../ui";
import { modelLabel } from "../../model-display";
import { formatNamespacedModelId, providerIconSrc } from "../../provider-icons";
import SubagentDelegationSection from "./SubagentDelegationSection";
import type { DelegationPatch, DelegationModelOption } from "../../pages/use-subagent-delegation";
import type { RosterReachability } from "../../pages/subagent-roster-reachability";
import CodexDelegationSetupCard from "./CodexDelegationSetupCard";
import type { CodexDelegationSetupController } from "../../pages/use-codex-delegation-setup";

export const FEATURED_MAX = 5;
export const LONG_CONTEXT_MIN = 200_000;
export const SUBAGENT_GUIDANCE_MAX_CODE_POINTS = 160;

function canonicalSubagentGuidance(guidance: string | undefined): string | undefined {
  const canonical = guidance?.normalize("NFC").trim();
  return canonical || undefined;
}

function subagentGuidanceControlId(model: string): string {
  return `subagent-guidance-${encodeURIComponent(model)}`;
}

export type SubagentRosterEntry = {
  model: string;
  guidance?: string;
};

export type CatalogState = {
  state: "fresh" | "stale" | "not_running" | "unknown";
  processes?: Array<{ pid: number; startedAtMs: number | null }>;
  catalogMtimeMs?: number | null;
};

export type AgentModelRow = {
  provider: string;
  id: string;
  namespaced: string;
  disabled?: boolean;
  native?: boolean;
  displayName?: string;
  contextWindow?: number;
  contextCap?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  capabilities?: string[];
  parallelToolCalls?: boolean;
};

type ModelFilter = "all" | "reasoning" | "context" | "vision" | "tools";

export interface SubagentsWorkspaceProps {
  available: string[];
  models: AgentModelRow[];
  chosen: SubagentRosterEntry[];
  protocol?: "v1" | "default" | "v2" | null;
  rosterReachability?: ReadonlyMap<string, RosterReachability>;
  onUseConcurrentV2?: () => void;
  busy?: boolean;
  rosterDirty?: boolean;
  rosterInvalid?: boolean;
  onToggle: (model: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onReorder: (from: number, to: number) => void;
  expandedModel: string | null;
  onExpandedModelChange: (model: string | null) => void;
  onGuidanceChange: (model: string, guidance: string) => void;
  onSave: () => void;
  delegation: {
    loaded?: boolean;
    model: string;
    effort: string;
    efforts: string[];
    available: DelegationModelOption[];
    guidanceEnabled: boolean;
    syncCodexDefaults: boolean;
    saving: boolean;
    onSave: (patch: DelegationPatch) => void | Promise<boolean>;
  };
  runPolicy?: React.ReactNode;
  delegationSetup: CodexDelegationSetupController;
}

function providerFromSelector(selector: string): string {
  const slash = selector.indexOf("/");
  return slash > 0 ? selector.slice(0, slash) : "openai";
}

function formatContextWindow(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function normalizedCapabilities(model: AgentModelRow): string[] {
  return (model.capabilities ?? []).map(value => value.toLowerCase());
}

function modelSupportsFilter(model: AgentModelRow, filter: ModelFilter): boolean {
  if (filter === "all") return true;
  const capabilities = normalizedCapabilities(model);
  if (filter === "reasoning") {
    return (model.reasoningEfforts?.length ?? 0) > 0 || capabilities.some(value => value.includes("reason"));
  }
  if (filter === "context") return (model.contextWindow ?? model.contextCap ?? 0) >= LONG_CONTEXT_MIN;
  if (filter === "vision") {
    return (model.inputModalities ?? []).some(value => value.toLowerCase() === "image")
      || capabilities.some(value => value.includes("vision") || value.includes("image"));
  }
  return model.parallelToolCalls === true
    || capabilities.some(value => value.includes("tool") || value.includes("function"));
}

function modelForSelector(selector: string, modelBySelector: Map<string, AgentModelRow>): AgentModelRow {
  const existing = modelBySelector.get(selector);
  if (existing) return existing;
  const slash = selector.indexOf("/");
  return {
    provider: providerFromSelector(selector),
    id: slash > 0 ? selector.slice(slash + 1) : selector,
    namespaced: selector,
    native: slash < 0,
  };
}

function ModelMark({ model }: { model: AgentModelRow }) {
  const selector = model.native ? model.id : model.namespaced;
  const nativeLabel = modelLabel(selector);
  if (typeof nativeLabel !== "string") return <span className="swi-model-mark swi-model-mark--native" aria-hidden="true">{nativeLabel}</span>;
  const icon = providerIconSrc(model.provider);
  return icon
    ? <img className="swi-model-mark" src={icon} alt="" aria-hidden="true" />
    : <IconBot className="swi-model-mark" aria-hidden="true" />;
}

function ModelChips({ model }: { model: AgentModelRow }) {
  const { locale, t } = useI18n();
  const chips: Array<{ id: string; label: string }> = [];
  if (modelSupportsFilter(model, "reasoning")) chips.push({ id: "reasoning", label: t("sub.cap.reasoning") });
  const context = model.contextWindow ?? model.contextCap;
  if (context && context > 0) chips.push({ id: "context", label: t("sub.cap.context", { n: formatContextWindow(context, locale) }) });
  if (modelSupportsFilter(model, "vision")) chips.push({ id: "vision", label: t("sub.cap.vision") });
  if (modelSupportsFilter(model, "tools")) chips.push({ id: "tools", label: t("sub.cap.tools") });
  if (chips.length === 0) return null;
  return (
    <span className="swi-model-chips" aria-label={t("sub.cap.available")}>
      {chips.slice(0, 3).map(chip => <span className="swi-model-chip" key={chip.id}>{chip.label}</span>)}
    </span>
  );
}

function surfaceLabel(surface: RosterReachability, t: TFn): string {
  switch (surface) {
    case "both": return t("sub.roster.surface.both");
    case "v1": return t("sub.roster.surface.v1");
    case "v2": return t("sub.roster.surface.v2");
    case "neither": return t("sub.roster.surface.none");
  }
}

export default function SubagentsWorkspace({
  available,
  models,
  chosen,
  protocol,
  rosterReachability,
  onUseConcurrentV2,
  busy = false,
  rosterDirty = false,
  rosterInvalid = false,
  onToggle,
  onMove,
  onReorder,
  expandedModel,
  onExpandedModelChange,
  onGuidanceChange,
  onSave,
  delegation,
  runPolicy,
  delegationSetup,
}: SubagentsWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const gripRefs = useRef<Map<string, HTMLButtonElement> | null>(null);
  if (gripRefs.current === null) gripRefs.current = new Map<string, HTMLButtonElement>();
  const gripRefMap = gripRefs.current;

  const restoreGripFocus = (selector: string) => {
    const focus = () => gripRefMap.get(selector)?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else setTimeout(focus, 0);
  };

  const chosenModels = useMemo(() => chosen.map(entry => entry.model), [chosen]);
  const chosenSet = useMemo(() => new Set(chosenModels), [chosenModels]);
  const full = chosen.length >= FEATURED_MAX;
  const modelBySelector = useMemo(() => {
    const next = new Map<string, AgentModelRow>();
    for (const model of models) {
      next.set(model.native ? model.id : model.namespaced, model);
      next.set(model.namespaced, model);
    }
    return next;
  }, [models]);
  const library = useMemo(() => available.map(selector => modelForSelector(selector, modelBySelector)), [available, modelBySelector]);
  const visibleModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return library.filter(model => {
      const selector = model.native ? model.id : model.namespaced;
      const matchesQuery = !normalizedQuery
        || selector.toLowerCase().includes(normalizedQuery)
        || (model.displayName ?? "").toLowerCase().includes(normalizedQuery)
        || model.provider.toLowerCase().includes(normalizedQuery);
      return matchesQuery && modelSupportsFilter(model, filter);
    });
  }, [filter, library, query]);

  const reorder = (from: number, to: number, focusSelector?: string) => {
    if (busy || from === to || from < 0 || to < 0 || from >= chosen.length || to >= chosen.length) return;
    onReorder(from, to);
    const moved = focusSelector ?? chosen[from]?.model;
    setAnnouncement(t("sub.reordered", { m: moved ?? "", n: to + 1 }));
    if (moved) restoreGripFocus(moved);
  };

  const moveWithAnnouncement = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= chosen.length) return;
    const moved = chosen[index]!.model;
    onMove(index, direction);
    setAnnouncement(t("sub.reordered", { m: moved, n: next + 1 }));
    restoreGripFocus(moved);
  };

  const filters: Array<{ id: ModelFilter; label: string }> = [
    { id: "all", label: t("sub.filter.all") },
    { id: "reasoning", label: t("sub.filter.reasoning") },
    { id: "context", label: t("sub.filter.context") },
    { id: "vision", label: t("sub.filter.vision") },
    { id: "tools", label: t("sub.filter.tools") },
  ];

  // Per-selector collaboration-surface exceptions among the chosen rows.
  const rosterStatus = useMemo(() => {
    const v1: string[] = [];
    const v2: string[] = [];
    if (rosterReachability) {
      for (const { model: selector } of chosen) {
        const state = rosterReachability.get(selector);
        if (state === "v1") v1.push(selector);
        else if (state === "v2") v2.push(selector);
      }
    }
    return { v1, v2 };
  }, [chosen, rosterReachability]);

  // One notice, only when the legacy "default" protocol splits the roster
  // across surfaces. The gate is inherently map-driven: rosterStatus only
  // collects entries from a non-empty rosterReachability map, so an empty or
  // missing map can never produce a notice. "neither" rows are deliberately
  // not listed by name. Names stay in roster order.
  const showSplitNotice = protocol === "default" && (rosterStatus.v1.length > 0 || rosterStatus.v2.length > 0);
  const v1Names = rosterStatus.v1.map(selector => formatNamespacedModelId(selector, t)).join(", ");
  const v2Names = rosterStatus.v2.map(selector => formatNamespacedModelId(selector, t)).join(", ");

  return (
    <div className="subagents-workspace-shell">
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <div className="subagents-command-grid">
        <section className="subagents-command-card swi-roster" aria-labelledby="configured-roster-title">
          <div className="swi-card-head">
            <div>
              <h2 id="configured-roster-title" className="swi-card-title">{t("sub.featured")}</h2>
              <p className="swi-card-subtitle">{t("sub.rosterCount", { n: chosen.length, max: FEATURED_MAX })}</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => searchRef.current?.focus()}>
              <IconPlus width={15} height={15} aria-hidden="true" />
              {t("sub.addFromLibrary")}
            </button>
          </div>

          {chosen.length === 0 ? (
            <div className="swi-featured-empty">
              <span>{t("sub.noneSelected")}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => searchRef.current?.focus()}>{t("sub.browseLibrary")}</button>
            </div>
          ) : (
            <ol className="swi-roster-list">
              {chosen.map((entry, index) => {
                const selector = entry.model;
                const guidance = entry.guidance ?? "";
                const canonicalGuidance = canonicalSubagentGuidance(guidance);
                const hasGuidance = canonicalGuidance !== undefined;
                const isExpanded = expandedModel === selector;
                const guidanceControlId = subagentGuidanceControlId(selector);
                const guidanceLength = [...(canonicalGuidance ?? "")].length;
                const guidanceTooLong = guidanceLength > SUBAGENT_GUIDANCE_MAX_CODE_POINTS;
                const model = modelForSelector(selector, modelBySelector);
                const state = rosterReachability?.get(selector);
                // Routed = namespaced row. modelForSelector always returns a
                // row with native = (no slash), so this stays computable even
                // when catalog metadata failed to load.
                const routed = model.native !== true;
                const dragging = dragIndex === index;
                const dropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
                return (
                  <li
                    key={selector}
                    className={`swi-roster-row${dragging ? " swi-roster-row--dragging" : ""}${dropTarget ? " swi-roster-row--drop" : ""}${isExpanded ? " swi-roster-row--expanded" : ""}`}
                    onDragOver={event => {
                      if (dragIndex === null) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (overIndex !== index) setOverIndex(index);
                    }}
                    onDrop={event => {
                      event.preventDefault();
                      if (dragIndex !== null) reorder(dragIndex, index);
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                  >
                    <button
                      type="button"
                      className="swi-roster-grip"
                      draggable={!busy}
                      disabled={busy}
                      ref={node => {
                        if (node) gripRefMap.set(selector, node);
                        else gripRefMap.delete(selector);
                      }}
                      aria-label={t("sub.dragAria", { m: selector, n: index + 1 })}
                      title={t("sub.dragHint")}
                      onDragStart={event => {
                        setDragIndex(index);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", String(index));
                      }}
                      onKeyDown={event => {
                        if (!event.altKey) return;
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          moveWithAnnouncement(index, -1);
                        } else if (event.key === "ArrowDown") {
                          event.preventDefault();
                          moveWithAnnouncement(index, 1);
                        }
                      }}
                    >
                      <IconGrip width={15} height={15} aria-hidden="true" />
                    </button>
                    <span className="swi-roster-rank" aria-hidden="true">{index + 1}</span>
                    <ModelMark model={model} />
                    <span className="swi-roster-identity">
                      <span className="swi-roster-name" title={formatNamespacedModelId(selector, t)}>{formatNamespacedModelId(selector, t)}</span>
                      {hasGuidance && <span className="swi-roster-guidance-preview" title={canonicalGuidance}>{canonicalGuidance}</span>}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm swi-roster-guidance-toggle"
                        onClick={() => onExpandedModelChange(isExpanded ? null : selector)}
                        disabled={busy}
                        aria-label={t(hasGuidance ? "sub.guidance.editAria" : "sub.guidance.addAria", { m: selector })}
                        aria-expanded={isExpanded}
                        aria-controls={guidanceControlId}
                      >{t(hasGuidance ? "sub.guidance.edit" : "sub.guidance.add")}</button>
                      {/* No map entry (e.g. unsaved draft row) => no claim at
                          all; the sr-only "both" line requires an explicit
                          "both" entry from the server. */}
                      {state !== undefined && (state === "both" ? (
                        <span className="sr-only">{t("sub.roster.status.bothSr")}</span>
                      ) : (
                        <span className={`swi-roster-status${state === "neither" ? " swi-roster-status--neither" : ""}`}>
                          {state === "v1"
                            ? t("sub.roster.status.v1Only")
                            : state === "v2"
                              ? routed ? t("sub.roster.status.routedV2") : t("sub.roster.status.v2Only")
                              : t("sub.roster.status.notAdvertised")}
                        </span>
                      ))}
                    </span>
                    <span className="swi-roster-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm swi-roster-arrow"
                        onClick={() => moveWithAnnouncement(index, -1)}
                        disabled={busy || index === 0}
                        aria-label={t("sub.moveUp", { m: selector })}
                      ><IconArrowUp aria-hidden="true" /></button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm swi-roster-arrow"
                        onClick={() => moveWithAnnouncement(index, 1)}
                        disabled={busy || index === chosen.length - 1}
                        aria-label={t("sub.moveDown", { m: selector })}
                      ><IconArrowDown aria-hidden="true" /></button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm swi-roster-remove"
                        onClick={() => onToggle(selector)}
                        disabled={busy}
                        aria-label={t("sub.removeAria", { m: selector })}
                      ><IconX aria-hidden="true" /></button>
                    </span>
                    {isExpanded && (
                      <div className="swi-roster-guidance-field">
                        <label htmlFor={guidanceControlId} className="swi-roster-guidance-label">{t("sub.guidance.label")}</label>
                        <textarea
                          id={guidanceControlId}
                          value={guidance}
                          placeholder={t("sub.guidance.placeholder")}
                          disabled={busy}
                          aria-label={t("sub.guidance.label")}
                          aria-invalid={guidanceTooLong || undefined}
                          aria-describedby={`subagent-guidance-hint-${index}${guidanceTooLong ? ` subagent-guidance-error-${index}` : ""}`}
                          onChange={event => onGuidanceChange(selector, event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Escape") onExpandedModelChange(null);
                            if (event.key === "ArrowUp" || event.key === "ArrowDown") event.stopPropagation();
                          }}
                        />
                        <span id={`subagent-guidance-hint-${index}`} className="swi-roster-guidance-hint">{t("sub.guidance.hint")}</span>
                        <div className="swi-roster-guidance-meta">
                          {hasGuidance && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onGuidanceChange(selector, "")}>{t("sub.guidance.clear")}</button>}
                          <span className={guidanceTooLong ? "swi-roster-guidance-count swi-roster-guidance-count--error" : "swi-roster-guidance-count"}>{guidanceLength}/{SUBAGENT_GUIDANCE_MAX_CODE_POINTS}</span>
                        </div>
                        {guidanceTooLong && <Notice tone="err"><span id={`subagent-guidance-error-${index}`}>{t("sub.guidance.tooLong")}</span></Notice>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {showSplitNotice && (
            <div className="swi-roster-note">
              <IconInfo width={15} height={15} aria-hidden="true" />
              <span className="swi-roster-note-text">
                {rosterStatus.v1.length > 0 && rosterStatus.v2.length > 0
                  ? t("sub.roster.splitNoticeBoth", { v1Models: v1Names, v2Models: v2Names })
                  : rosterStatus.v1.length > 0
                    ? t("sub.roster.splitNoticeV2", { models: v1Names })
                    : t("sub.roster.splitNoticeV1", { models: v2Names })}
              </span>
              {/* Focus-only navigation: the button never mutates drafts, so it
                  stays enabled while the roster is busy. The hint travels via
                  aria-describedby on a dedicated sr-only span — a reliable
                  accessible description without re-announcing the full note
                  text that sits directly adjacent. */}
              <button
                type="button"
                className="btn btn-ghost btn-sm swi-roster-note-action"
                onClick={() => onUseConcurrentV2?.()}
                aria-describedby="swi-roster-note-action-hint"
              >{t("sub.roster.useConcurrentV2")}</button>
              <span id="swi-roster-note-action-hint" className="sr-only">{t("sub.roster.useConcurrentV2Hint")}</span>
            </div>
          )}

          {rosterReachability && rosterReachability.size > 0 && (
            <details className="swi-roster-diagnostics">
              <summary>{t("sub.roster.diagnostics")}</summary>
              <p>{t("sub.roster.diagnosticsHint")}</p>
              <ul className="swi-roster-matrix">
                {chosenModels.map(selector => {
                  const surface = rosterReachability.get(selector);
                  if (!surface) return null;
                  return (
                    <li className="swi-roster-matrix-row" key={selector}>
                      <span className="swi-roster-matrix-name" title={formatNamespacedModelId(selector, t)}>{formatNamespacedModelId(selector, t)}</span>
                      <span className="swi-roster-matrix-surface">{surfaceLabel(surface, t)}</span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          <div className="swi-card-footer">
            <span><IconInfo width={15} height={15} aria-hidden="true" />{t("sub.dragHint")}</span>
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || !rosterDirty || rosterInvalid}>
              {busy ? t("sub.saving") : t("sub.saveRoster")}
            </button>
          </div>
        </section>

        <section className="subagents-command-card swi-library" aria-labelledby="agent-library-title">
          <div className="swi-card-head swi-library-head">
            <div>
              <h2 id="agent-library-title" className="swi-card-title">{t("sub.models")}</h2>
              <p className="swi-card-subtitle">{t("sub.libraryCount", { n: available.length })}</p>
            </div>
            <label className="swi-library-search">
              <IconSearch width={16} height={16} aria-hidden="true" />
              <span className="sr-only">{t("sub.search")}</span>
              <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("sub.search")} />
            </label>
          </div>
          <div className="swi-library-filters" aria-label={t("sub.filter.label")}>
            {filters.map(option => (
              <button
                type="button"
                className={`swi-filter${filter === option.id ? " swi-filter--active" : ""}`}
                key={option.id}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >{option.label}</button>
            ))}
          </div>
          <ul className="swi-library-list">
            {visibleModels.length === 0 ? (
              <li className="subagents-workspace-rail-empty">{t("sub.noMatchingModels")}</li>
            ) : visibleModels.map(model => {
              const selector = model.native ? model.id : model.namespaced;
              const selected = chosenSet.has(selector);
              const priority = selected ? chosenModels.indexOf(selector) + 1 : null;
              const blocked = !selected && (full || busy);
              return (
                <li className={`swi-library-row${selected ? " swi-library-row--selected" : ""}`} key={selector}>
                  <ModelMark model={model} />
                  <span className="swi-library-identity">
                    <span className="swi-library-name" title={formatNamespacedModelId(selector, t)}>{formatNamespacedModelId(selector, t)}</span>
                    <ModelChips model={model} />
                  </span>
                  {priority && <span className="swi-library-priority">#{priority}</span>}
                  <button
                    type="button"
                    className={`swi-library-toggle${selected ? " swi-library-toggle--selected" : ""}`}
                    onClick={() => { if (!blocked) onToggle(selector); }}
                    disabled={blocked}
                    aria-pressed={selected}
                    aria-label={selected
                      ? t("sub.workspace.removeFromFeatured", { m: selector })
                      : t("sub.workspace.addToFeatured", { m: selector })}
                    title={selected
                      ? t("sub.workspace.removeFromFeatured", { m: selector })
                      : full ? t("sub.workspace.featuredFull") : t("sub.workspace.addToFeatured", { m: selector })}
                  >{selected ? <IconCheck aria-hidden="true" /> : <IconPlus aria-hidden="true" />}</button>
                </li>
              );
            })}
          </ul>
          <div className="swi-card-footer swi-library-footer">
            <span><IconInfo width={15} height={15} aria-hidden="true" />{t("sub.libraryHint")}</span>
          </div>
        </section>
      </div>

      <section className="subagents-command-card swi-policy" aria-labelledby="run-policy-title">
        <div className="swi-card-head">
          <div>
            <h2 id="run-policy-title" className="swi-card-title">{t("sub.settings")}</h2>
            <p className="swi-card-subtitle">{t("sub.policyHint")}</p>
          </div>
        </div>
        {runPolicy ?? (
          <SubagentDelegationSection
            model={delegation.model}
            effort={delegation.effort}
            efforts={delegation.efforts}
            available={delegation.available}
            guidanceEnabled={delegation.guidanceEnabled}
            syncCodexDefaults={delegation.syncCodexDefaults}
            saving={delegation.saving}
            onSave={delegation.onSave}
          />
        )}
      </section>
      <CodexDelegationSetupCard delegationSetup={delegationSetup} />
    </div>
  );
}
