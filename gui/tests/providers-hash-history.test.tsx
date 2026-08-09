import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { Window } from "happy-dom";
import { normalizeHashPath, replaceHash, navigateHash } from "../src/hash-routing";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange } from "../src/app-routing";

/**
 * Hash routing contract after WP5 removed the Classic/Workspace split.
 *
 * Covers generic helpers, history semantics, canonical provider deep links,
 * and passive normalization.
 */

describe("hash helpers", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map((k) => [k, Reflect.get(globalThis, k)]));
    win = new Window({ url: "http://localhost/#providers" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const k of keys) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
  });

  test("normalizeHashPath strips the leading marker in both forms", () => {
    expect(normalizeHashPath("#providers")).toBe("providers");
    expect(normalizeHashPath("#/providers")).toBe("providers");
    expect(normalizeHashPath("providers")).toBe("providers");
  });

  test("replaceHash does not increase history length", () => {
    const before = win.history.length;
    replaceHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBe(before);
  });

  test("navigateHash creates a deliberate history entry", () => {
    const before = win.history.length;
    navigateHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBeGreaterThan(before);
  });
});

describe("route resolution", () => {
  test("bare page hashes resolve without a rewrite", () => {
    for (const page of ["dashboard", "providers", "models", "logs", "usage"]) {
      expect(resolveAppHashChange(page).replaceTo).toBeNull();
    }
  });

  test("canonical provider deep links remain selected", () => {
    expect(hashBelongsToPage("providers/example", "providers")).toBe(true);
    const action = resolveAppHashChange("providers/example");
    expect(action.page).toBe("providers");
    expect(action.replaceTo).toBeNull();
  });

  test("registered sub-hashes survive; unknown ones are normalised away", () => {
    expect(resolveAppHashChange("logs/debug").replaceTo).toBeNull();
    expect(resolveAppHashChange("dashboard/models").replaceTo).toBeNull();
    // Provider detail deep links are valid at the App layer; unknown providers are
    // handled by the Providers page after config loads (replaceState to #providers).
    expect(resolveAppHashChange("providers/nope").replaceTo).toBeNull();
    expect(resolveAppHashChange("providers/openai/accounts").replaceTo).toBeNull();
    expect(resolveAppHashChange("providers/openai/nope").replaceTo).toBe("providers/openai/overview");
    expect(resolveAppHashChange("models/nope").replaceTo).toBe("models");
  });

  test("an unknown page falls back to the dashboard", () => {
    expect(readPageFromHash("#nonsense")).toBe("dashboard");
  });
});


describe("useAppRouteState (real hook)", () => {
  const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  let previous: Record<(typeof globals)[number], unknown>;
  let win: Window;
  let host: HTMLElement;
  let root: import("react-dom/client").Root | null = null;

  async function mountAt(hash: string, storage?: Storage) {
    win = new Window({ url: `http://localhost/${hash}` });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: win.document },
      window: { configurable: true, value: win },
      navigator: { configurable: true, value: win.navigator },
      localStorage: { configurable: true, value: storage ?? win.localStorage },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);

    // Lazy imports: a static react-dom/client import binds to the document that existed
    // when the module graph loaded and corrupts sibling suites in the same process.
    const [{ act }, { createRoot }, { useAppRouteState }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../src/use-app-route-state"),
    ]);
    const seen: { current: ReturnType<typeof useAppRouteState> | null } = { current: null };
    function Probe() {
      seen.current = useAppRouteState();
      return null;
    }
    await act(async () => {
      root = createRoot(host);
      root.render(<Probe />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return { seen, act };
  }

  beforeEach(() => {
    previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      const { act } = await import("react");
      await act(async () => { current.unmount(); });
      root = null;
    }
    for (const key of globals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  test("an unknown suffix is normalised through the hook", async () => {
    const { seen } = await mountAt("#models/nope");
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(seen.current!.page).toBe("models");
  });

  test("navigateToPage pushes a history entry", async () => {
    const { seen, act } = await mountAt("#dashboard");
    const before = win.history.length;
    await act(async () => {
      seen.current!.navigateToPage("models");
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBeGreaterThan(before);
  });

  test("a throwing storage does not break routing", async () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;

    const { seen } = await mountAt("#providers/example", throwing);
    // Route normalization does not depend on storage access.
    expect(normalizeHashPath(win.location.hash)).toBe("providers/example");
    expect(seen.current!.page).toBe("providers");
  });
});
