import { realpathSync } from "node:fs";

/** Resolves physical paths; argv/environment claims alone cannot prove bundle ownership. */
export function inspectMacosRuntimeBundleProvenance(
  modulePath = import.meta.path,
  executablePath = process.execPath,
): { kind: "bundle" | "independent" | "mixed" | "unknown"; bundlePath: string | null } {
  try {
    const containingBundle = (path: string): string | null => {
      const physical = realpathSync(path);
      const marker = ".app/Contents/";
      const offset = physical.lastIndexOf(marker);
      return offset < 0 ? null : physical.slice(0, offset + 4);
    };
    const moduleBundle = containingBundle(modulePath);
    const executableBundle = containingBundle(executablePath);
    if (!moduleBundle && !executableBundle) return { kind: "independent", bundlePath: null };
    if (!moduleBundle || !executableBundle || moduleBundle !== executableBundle) {
      return { kind: "mixed", bundlePath: moduleBundle ?? executableBundle };
    }
    return { kind: "bundle", bundlePath: moduleBundle };
  } catch { return { kind: "unknown", bundlePath: null }; }
}
export function macosRuntimeBundlePath(modulePath = import.meta.path, executablePath = process.execPath): string | null {
  const provenance = inspectMacosRuntimeBundleProvenance(modulePath, executablePath);
  return provenance.kind === "bundle" ? provenance.bundlePath : null;
}
