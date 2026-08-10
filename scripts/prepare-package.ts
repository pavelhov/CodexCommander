import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafePackageFile, assertSafePackageTree } from "./package-tree-safety";

const root = realpathSync(dirname(fileURLToPath(new URL("../package.json", import.meta.url))));

/**
 * Mirror the package's two CLI names in `dist/bin` for source-tree consumers. The
 * generated links share the one physical launcher at `bin/ccx.mjs`. Symlinks are
 * best-effort on Windows, where creating them can require privileges.
 */
const DIST_BIN_ALIASES = [
  "codexcommander",
  "ccx",
] as const;

function ensureDistBinAliases(): void {
  const distRoot = join(root, "dist");
  const distBin = join(root, "dist", "bin");
  const sourceLauncher = join(root, "bin", "ccx.mjs");
  if (!existsSync(sourceLauncher)) return;
  if (!ensureDirectory(distRoot, "dist") || !ensureDirectory(distBin, "dist/bin")) return;
  ensureSymlink(join(distBin, "ccx.mjs"), relative(distBin, sourceLauncher));
  for (const alias of DIST_BIN_ALIASES) {
    ensureSymlink(join(distBin, alias), "ccx.mjs");
  }
}

function ensureDirectory(path: string, label: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return true;
    console.warn(`prepare-package: refusing to write through ${label} because it is not a physical directory`);
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn(`prepare-package: could not inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    console.warn(`prepare-package: could not create ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function ensureSymlink(path: string, target: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink dist/bin/${path.split(/[\\/]/).pop()}`);
    }
    if (readlinkSync(path) === target) return;
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn(`prepare-package: could not inspect dist/bin/${path.split(/[\\/]/).pop()}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  try {
    symlinkSync(target, path);
  } catch (error) {
    console.warn(`prepare-package: could not create dist/bin/${path.split(/[\\/]/).pop()} symlink: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The tracked launcher already has its executable mode. Do not chmod build inputs: even
// an immediately-preceding lstat cannot make a pathname chmod race-free. Validate every
// source input instead, so preparation never follows a link or alters a shared inode.
assertSafePackageFile(join(root, "bin", "ccx.mjs"), "bin/ccx.mjs", root);
assertSafePackageFile(join(root, "bin", "package-main.mjs"), "bin/package-main.mjs", root);
assertSafePackageTree(join(root, "gui", "dist"), "gui/dist", root);
ensureDistBinAliases();
