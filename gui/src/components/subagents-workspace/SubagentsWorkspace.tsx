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
import { useI18n, useT, type Locale } from "../../i18n/shared";
import { modelLabel } from "../../model-display";
import { formatNamespacedModelId, providerIconSrc } from "../../provider-icons";
import SubagentDelegationSection from "./SubagentDelegationSection";
import type { DelegationPatch, DelegationModelOption } from "../../pages/use-subagent-delegation";

export const FEATURED_MAX = 5;
export const LONG_CONTEXT_MIN = 200_000;

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
  chosen: string[];
  busy?: boolean;
  rosterDirty?: boolean;
  onToggle: (model: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onReorder: (from: number, to: number) => void;
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

export default function SubagentsWorkspace({
  available,
  models,
  chosen,
  busy = false,
  rosterDirty = false,
  onToggle,
  onMove,
  onReorder,
  onSave,
  delegation,
  runPolicy,
}: SubagentsWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());

  const restoreGripFocus = (selector: string) => {
    const focus = () => gripRefs.current.get(selector)?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else setTimeout(focus, 0);
  };

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
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
    const moved = focusSelector ?? chosen[from];
    setAnnouncement(t("sub.reordered", { m: moved ?? "", n: to + 1 }));
    if (moved) restoreGripFocus(moved);
  };

  const moveWithAnnouncement = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= chosen.length) return;
    const moved = chosen[index]!;
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

  return (
    <div className="subagents-workspace-shell">
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <div className="subagents-command-grid">
        <section className="subagents-command-card swi-roster" aria-labelledby="active-roster-title">
          <div className="swi-card-head">
            <div>
              <h2 id="active-roster-title" className="swi-card-title">{t("sub.featured")}</h2>
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
              {chosen.map((selector, index) => {
                const model = modelForSelector(selector, modelBySelector);
                const dragging = dragIndex === index;
                const dropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
                return (
                  <li
                    key={selector}
                    className={`swi-roster-row${dragging ? " swi-roster-row--dragging" : ""}${dropTarget ? " swi-roster-row--drop" : ""}`}
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
                        if (node) gripRefs.current.set(selector, node);
                        else gripRefs.current.delete(selector);
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
                      <span className="swi-roster-name">{formatNamespacedModelId(selector, t)}</span>
                      <ModelChips model={model} />
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
                  </li>
                );
              })}
            </ol>
          )}

          <div className="swi-card-footer">
            <span><IconInfo width={15} height={15} aria-hidden="true" />{t("sub.dragHint")}</span>
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || !rosterDirty}>
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
          <div className="swi-library-list" role="list">
            {visibleModels.length === 0 ? (
              <div className="subagents-workspace-rail-empty">{t("sub.noMatchingModels")}</div>
            ) : visibleModels.map(model => {
              const selector = model.native ? model.id : model.namespaced;
              const selected = chosenSet.has(selector);
              const priority = selected ? chosen.indexOf(selector) + 1 : null;
              const blocked = !selected && (full || busy);
              return (
                <div className={`swi-library-row${selected ? " swi-library-row--selected" : ""}`} key={selector} role="listitem">
                  <ModelMark model={model} />
                  <span className="swi-library-identity">
                    <span className="swi-library-name">{formatNamespacedModelId(selector, t)}</span>
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
                </div>
              );
            })}
          </div>
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
    </div>
  );
}
