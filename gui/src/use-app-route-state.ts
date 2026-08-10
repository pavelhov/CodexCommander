import { useCallback, useEffect, useState } from "react";
import {
  readPageFromHash,
  resolveAppHashChange,
  type Page,
} from "./app-routing";
import { navigateHash, normalizeHashPath, replaceHash } from "./hash-routing";

/**
 * Production App route ownership. Hash page changes push history; normalization of an
 * unknown sub-hash replaces the current entry so Back is never trapped on a URL the
 * router immediately rewrites.
 */
export function useAppRouteState() {
  const [page, setPageState] = useState<Page>(readPageFromHash);

  const applyHashAction = useCallback((rawHash: string) => {
    const action = resolveAppHashChange(rawHash);
    if (action.replaceTo) replaceHash(action.replaceTo);
    setPageState(action.page);
  }, []);

  /**
   * Deliberate navigation. `subPath` deep-links a registered page sub-view;
   * `hashBelongsToPage` must accept it, otherwise the normalization effect below
   * strips it right back off.
   */
  const navigateToPage = (id: Page, subPath?: string) => {
    const target = subPath ? `${id}/${subPath}` : id;
    navigateHash(target);
    setPageState(id);
  };

  useEffect(() => {
    const onRouteHash = () => {
      applyHashAction(normalizeHashPath(window.location.hash));
    };
    // hashchange covers location.hash assignment; popstate covers Back/Forward.
    window.addEventListener("hashchange", onRouteHash);
    window.addEventListener("popstate", onRouteHash);
    return () => {
      window.removeEventListener("hashchange", onRouteHash);
      window.removeEventListener("popstate", onRouteHash);
    };
  }, [applyHashAction]);

  /*
   * Initial mount and page-driven normalization go through the SAME resolver.
   *
   * Initial mount and later hash changes share the same canonical resolver so
   * the selected page and normalized URL cannot diverge.
   */
  useEffect(() => {
    const rawHash = normalizeHashPath(window.location.hash);
    const action = resolveAppHashChange(rawHash);
    if (action.replaceTo) replaceHash(action.replaceTo);
    /*
     * Initial state comes from `readPageFromHash`, so this normally agrees
     * already. The guard covers the one gap it cannot: a hash changed between
     * render and effect commit, before the `hashchange` listener below is
     * registered. Without it that change is observed by nobody and the page
     * renders against a hash it no longer matches.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reconciles a hash changed before the listener existed; the equality check bounds it to one render
    if (action.page !== page) setPageState(action.page);
  }, [page]);

  return {
    page,
    setPageState,
    navigateToPage,
  };
}
