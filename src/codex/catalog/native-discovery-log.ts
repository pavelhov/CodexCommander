import { AsyncLocalStorage } from "node:async_hooks";

const suppressed = new AsyncLocalStorage<boolean>();

/** Local CLI sync prints its returned notice once, instead of process diagnostics. */
export function withNativeDiscoveryLogsSuppressed<T>(work: () => Promise<T>): Promise<T> {
  return suppressed.run(true, work);
}

export function nativeDiscoveryLogsSuppressed(): boolean {
  return suppressed.getStore() === true;
}
