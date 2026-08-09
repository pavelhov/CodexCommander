import { lstatSync, realpathSync, readdirSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

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
