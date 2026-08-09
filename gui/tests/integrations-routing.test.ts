import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
  resolvedNavigationHash,
  INTEGRATION_TAB_HASHES,
  VALID_PAGES,
} from "../src/app-routing";
import { normalizeHashPath, replaceHash } from "../src/hash-routing";

/** Canonical Integration routes and passive normalization semantics. */

describe("top-level route hard cut", () => {
  test("unknown page ids normalize to the dashboard", () => {
    expect(readPageFromHash("unknown-page")).toBe("dashboard");
    expect(resolveAppHashChange("unknown-page")).toEqual({
      page: "dashboard",
      replaceTo: "dashboard",
    });
    expect(resolvedNavigationHash("#unknown-page")).toBe("dashboard");
  });

  test("only canonical page ids are registered", () => {
    expect(VALID_PAGES.has("integrations")).toBe(true);
    expect(VALID_PAGES.has("unknown-page" as never)).toBe(false);
  });
});

describe("registered nested hashes", () => {
  test("every registered tab hash survives untouched", () => {
    for (const raw of INTEGRATION_TAB_HASHES) {
      expect(readPageFromHash(raw)).toBe("integrations");
      expect(hashBelongsToPage(raw, "integrations")).toBe(true);
      const action = resolveAppHashChange(raw);
      expect(action.page).toBe("integrations");
      // A registered hash must never be passively replaced.
      expect(action.replaceTo).toBeNull();
    }
  });

  test("the two-segment Claude Desktop route is registered", () => {
    /*
     * Claude Desktop is owned by the inner Claude panel, but it has to appear
     * in the registry or App normalization strips the suffix before Claude can
     * read it — the panel would open on Claude Code every time.
     */
    expect(INTEGRATION_TAB_HASHES).toContain("integrations/claude/desktop");
    expect(resolveAppHashChange("integrations/claude/desktop").replaceTo).toBeNull();
  });

  test("bare #integrations is Overview and has no suffix of its own", () => {
    expect(readPageFromHash("integrations")).toBe("integrations");
    expect(hashBelongsToPage("integrations", "integrations")).toBe(true);
    expect(resolveAppHashChange("integrations").replaceTo).toBeNull();
    expect(INTEGRATION_TAB_HASHES).not.toContain("integrations/overview");
  });

  test("an unregistered suffix is normalized back to the bare page", () => {
    const action = resolveAppHashChange("integrations/nonsense");
    expect(action.page).toBe("integrations");
    expect(action.replaceTo).toBe("integrations");
  });
});

describe("neighbouring canonical routes", () => {
  test("logs, dashboard and providers keep their contracts", () => {
    expect(hashBelongsToPage("logs/debug", "logs")).toBe(true);
    expect(resolveAppHashChange("providers/example").replaceTo).toBeNull();
    // Cross-page suffixes stay invalid in both directions.
    expect(hashBelongsToPage("integrations/keys", "dashboard")).toBe(false);
    expect(hashBelongsToPage("logs/debug", "integrations")).toBe(false);
  });
});

describe("history semantics", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
    win = new Window({ url: "http://localhost/#integrations/nonsense" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const key of keys) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  test("normalizing an unknown nested route adds no history entry", () => {
    const before = win.history.length;
    const action = resolveAppHashChange(normalizeHashPath(win.location.hash));
    expect(action.replaceTo).toBe("integrations");
    replaceHash(action.replaceTo!, win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("integrations");
    expect(win.history.length).toBe(before);
  });

  test("the corrected hash is terminal", () => {
    expect(resolveAppHashChange("integrations").replaceTo).toBeNull();
  });
});
