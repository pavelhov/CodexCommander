import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function failsContainment(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.startsWith("..") || isAbsolute(path);
}

function physicalPath(path: string, label: string, root: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);

  const physical = realpathSync(path);
  if (failsContainment(root, physical)) {
    throw new Error(`${label} resolves outside its trusted package root`);
  }
  return physical;
}

function resolveTrustedRoot(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("trusted package root must be a physical directory");
  }
  return realpathSync(path);
}

function assertSafeRegularFile(path: string, label: string, root: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`${label} must not be multiply linked`);
  }
  physicalPath(path, label, root);
}

/**
 * Reject inputs that could make packaging read or copy an object outside the declared
 * source tree. Callers validate the whole tree before copying into a clean stage.
 */
export function assertSafePackageTree(path: string, label: string, trustedRoot: string): void {
  const root = resolveTrustedRoot(trustedRoot);
  const tree = physicalPath(path, label, root);
  const treeStat = lstatSync(tree);
  if (!treeStat.isDirectory()) throw new Error(`${label} must be a physical directory`);

  const inspect = (current: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    physicalPath(current, label, root);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) inspect(`${current}/${entry}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`${label} contains a non-regular file`);
    if (stat.nlink !== 1) throw new Error(`${label} contains a multiply-linked file`);
  };

  inspect(tree);
}

export function assertSafePackageFile(path: string, label: string, trustedRoot: string): void {
  const root = resolveTrustedRoot(trustedRoot);
  assertSafeRegularFile(path, label, root);
}

/**
 * Package-manager trees may contain relative shim links. Absolute targets and
 * any link that escapes the trusted root are refused before the tree is archived.
 */
export function assertSafeBundledSymlinks(path: string, label: string, trustedRoot: string): void {
  const root = resolveTrustedRoot(trustedRoot);
  const walk = (current: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(current);
      if (isAbsolute(target)) {
        throw new Error(`${label} contains an absolute symlink`);
      }
      let physical: string;
      try {
        physical = realpathSync(current);
      } catch {
        physical = resolve(join(current, ".."), target);
      }
      if (failsContainment(root, physical)) {
        throw new Error(`${label} contains a symlink that escapes its trusted root`);
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) walk(join(current, entry));
    }
  };
  walk(path);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "--check-symlinks") {
    const tree = process.argv[3];
    const trustedRoot = process.argv[4];
    if (!tree || !trustedRoot) {
      console.error("usage: package-tree-safety.ts --check-symlinks <tree> <trusted-root>");
      process.exit(1);
    }
    assertSafeBundledSymlinks(tree, "bundled node_modules", trustedRoot);
  }
}
