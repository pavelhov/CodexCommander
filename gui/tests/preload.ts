/**
 * GUI test preload. Happy-dom Windows omit the IE `window.event` field React 19
 * reads in `resolveUpdatePriority`. A late `dispatchSetState` after a test
 * restores `globalThis.window` to undefined then throws, and in a shared-global
 * `bun test tests` run that poisons every later file — the GHA-only failure
 * mode. Stub the field on every Window, and leave a tiny window object behind
 * after each file so a stray tick cannot throw.
 */
import { afterEach } from "bun:test";
import { Window } from "happy-dom";

if (!Object.prototype.hasOwnProperty.call(Window.prototype, "event")) {
  Object.defineProperty(Window.prototype, "event", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

process.env.TZ ??= "UTC";

const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };

afterEach(() => {
  const current = (globalThis as { window?: { event?: unknown } | null }).window;
  if (current == null || typeof current !== "object") {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: WINDOW_EVENT_STUB,
    });
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(current, "event")) {
    try {
      Object.defineProperty(current, "event", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    } catch {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: WINDOW_EVENT_STUB,
      });
    }
  }
});
