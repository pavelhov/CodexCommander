import { statSync } from "node:fs";
import { readCodexTokensResult } from "../auth-collision";
import { canonicalCodexHomeDir } from "../home";
import { nativeCatalogOwnerDecision, resetNativeCatalogOwnerMemoForTests } from "./native-owner";
import { peekNativeLiveCatalog } from "./native-live";
import { activeCodexConfigPath, readCatalog, readCodexCatalogPath, type RawCatalog } from "./parsing";

let memo: { home: string; configStamp: string; catalogStamp: string; catalog: RawCatalog | null } | null = null;

function stamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}\0${stat.dev}\0${stat.ino}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.size}`;
  } catch {
    return `${path}\0missing`;
  }
}

/** Read the published catalog once per config/catalog file revision. */
export function readPublishedNativeCatalog(): RawCatalog | null {
  const home = canonicalCodexHomeDir();
  const configStamp = stamp(activeCodexConfigPath());
  const path = memo?.home === home && memo.configStamp === configStamp
    ? memo.catalogStamp.split("\0", 1)[0]!
    : readCodexCatalogPath();
  const catalogStamp = stamp(path);
  if (memo?.home === home && memo.configStamp === configStamp && memo.catalogStamp === catalogStamp) return memo.catalog;
  const catalog = readCatalog(path);
  memo = { home, configStamp, catalogStamp, catalog };
  return catalog;
}

/** Published native rows are fallback evidence for this account only during an outage. */
export function readOwnerCheckedPublishedNativeCatalog(): RawCatalog | null {
  if (peekNativeLiveCatalog().catalog !== null) return null;
  const home = canonicalCodexHomeDir();
  const tokenRead = readCodexTokensResult(home);
  if (tokenRead.status === "missing" || tokenRead.status === "signed-out") return null;
  if (nativeCatalogOwnerDecision(home, tokenRead) === "mismatch") return null;
  return readPublishedNativeCatalog();
}

export function resetPublishedNativeCatalogMemoForTests(): void {
  memo = null;
  resetNativeCatalogOwnerMemoForTests();
}
