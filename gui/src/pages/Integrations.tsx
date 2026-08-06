import { useEffect, useState } from "react";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { IconChevron } from "../icons";
import { useT } from "../i18n/shared";
import ApiKeys from "./ApiKeys";
import Claude from "./Claude";
import Grok from "./Grok";
import ClientAppsPage from "./integrations/ClientAppsPage";
import FileIntegrationPage, {
  type FileIntegrationClientId,
} from "./integrations/FileIntegrationPage";
import OpenCodeIntegrationPage from "./integrations/OpenCodeIntegrationPage";

type IntegrationTab =
  | "overview"
  | "keys"
  | "codex"
  | "claude"
  | "grok"
  | "opencode"
  | FileIntegrationClientId;

interface ViewDefinition {
  id: IntegrationTab;
  hash: string;
}

const VIEWS: readonly ViewDefinition[] = [
  { id: "overview", hash: "integrations" },
  { id: "keys", hash: "integrations/keys" },
  { id: "codex", hash: "integrations/codex" },
  { id: "claude", hash: "integrations/claude" },
  { id: "grok", hash: "integrations/grok" },
  { id: "opencode", hash: "integrations/opencode" },
  { id: "pi", hash: "integrations/pi" },
  { id: "hermes", hash: "integrations/hermes" },
  { id: "openclaw", hash: "integrations/openclaw" },
  { id: "kimi", hash: "integrations/kimi" },
  { id: "gajae", hash: "integrations/gajae" },
] as const;

const FILE_CLIENTS = new Set<FileIntegrationClientId>([
  "pi",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
]);

function readIntegrationTab(hash = window.location.hash): IntegrationTab {
  const raw = normalizeHashPath(hash);
  if (raw === "integrations/claude/desktop") return "claude";
  const match = VIEWS.find(view => view.hash === raw);
  return match?.id ?? "overview";
}

export default function Integrations({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [tab, setTab] = useState<IntegrationTab>(readIntegrationTab);
  /*
   * Panels mount lazily and then STAY mounted, hidden, so a half-typed key or
   * an unsaved Grok selection survives a tab hop. Each mounted panel is gated
   * by `active`, which is what stops a hidden one from polling.
   */
  const [mounted, setMounted] = useState<ReadonlySet<IntegrationTab>>(
    () => new Set([readIntegrationTab()]),
  );

  /*
   * Every tab change goes through here, whether it came from a click or from
   * the browser's own history. Accumulating the mounted set in an effect
   * instead would run a second render pass after every switch for a value
   * both callers already know.
   */
  const activateTab = (next: IntegrationTab) => {
    setTab(next);
    setMounted(current => (current.has(next) ? current : new Set([...current, next])));
  };

  useEffect(() => {
    const syncFromHash = () => activateTab(readIntegrationTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  useEffect(() => {
    // The dashboard's fixed-height shell makes body the mobile scroll container.
    // Reset both candidates so opening a detail view never inherits the catalog's
    // scroll position (and direct deep links consistently start at the heading).
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
  }, [tab]);

  return (
    <section className="integrations-page">
      {VIEWS.map(definition => {
        if (!mounted.has(definition.id)) return null;
        const active = tab === definition.id;
        return (
          <div
            key={definition.id}
            className="client-apps-view"
            data-client-apps-view={definition.id}
            hidden={!active}
          >
            {definition.id !== "overview" && (
              <button type="button" className="client-apps-back" onClick={() => navigateHash("integrations")}>
                <IconChevron aria-hidden="true" /> {t("clientApps.action.back")}
              </button>
            )}
            {definition.id === "overview" && (
              <ClientAppsPage apiBase={apiBase} active={active} />
            )}
            {definition.id === "keys" && <ApiKeys apiBase={apiBase} active={active} />}
            {definition.id === "codex" && (
              <section className="integration-native-page" aria-labelledby="codex-integration-title">
                <h3 id="codex-integration-title">{t("integrations.codex.title")}</h3>
                <p>{t("integrations.codex.body")}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => navigateHash("startup")}
                >
                  {t("integrations.codex.openService")}
                </button>
              </section>
            )}
            {definition.id === "claude" && <Claude apiBase={apiBase} active={active} />}
            {definition.id === "grok" && <Grok apiBase={apiBase} active={active} />}
            {definition.id === "opencode" && (
              <OpenCodeIntegrationPage apiBase={apiBase} active={active} />
            )}
            {FILE_CLIENTS.has(definition.id as FileIntegrationClientId) && (
              <FileIntegrationPage
                apiBase={apiBase}
                client={definition.id as FileIntegrationClientId}
                active={active}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
