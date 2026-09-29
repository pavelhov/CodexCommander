/** The published Codex picker is a separate snapshot from Commander's provider discovery. */
export function listedCodexModelSlugs(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const slugs: string[] = [];
  for (const model of models) {
    if (model === null || typeof model !== "object" || Array.isArray(model)) return null;
    const { slug, visibility } = model as { slug?: unknown; visibility?: unknown };
    if (typeof slug !== "string" || !slug) return null;
    if (visibility === "list") slugs.push(slug);
  }
  return [...new Set(slugs)];
}

/** Only claim a routed model is absent when the published snapshot was read successfully. */
export function commanderOnlyModel(
  model: { native?: boolean; namespaced: string },
  enabled: boolean,
  listedSlugs: ReadonlySet<string> | null,
): boolean {
  return enabled && model.native !== true && listedSlugs !== null && !listedSlugs.has(model.namespaced);
}

/** null means status is unproven; zero means no running worker needs a reload. */
export function staleCodexWorkerCount(value: unknown): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const activation = (value as { activation?: unknown }).activation;
  if (activation === null || typeof activation !== "object" || Array.isArray(activation)) return null;
  const state = activation as {
    schemaVersion?: unknown;
    catalog?: { status?: unknown };
    routing?: { status?: unknown };
    workers?: { status?: unknown; staleCount?: unknown };
  };
  if (state.schemaVersion !== 1 || state.catalog?.status !== "current" || state.routing?.status !== "current") return null;
  if (state.workers?.status === "current" || state.workers?.status === "not_running") return 0;
  if (state.workers?.status === "reload_required"
    && Number.isInteger(state.workers.staleCount)
    && (state.workers.staleCount as number) > 0) return state.workers.staleCount as number;
  return null;
}
