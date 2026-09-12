import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { assertSafePackageFile } from './package-tree-safety';

export function validateBuildNumber(value: string | undefined, previous?: string): string {
  if (!value || !/^[1-9][0-9]{0,14}$/.test(value)) throw new Error('MACOS_BUILD_NUMBER must be an explicit positive integer (at most 15 digits)');
  if (previous !== undefined) {
    // The bootstrap baseline is the last pre-updater CFBundleVersion, 0.1.6.
    if (!/^(0|[1-9][0-9]{0,14})(\.(0|[1-9][0-9]{0,14})){0,2}$/.test(previous)) throw new Error('MACOS_PREVIOUS_BUILD_NUMBER must identify the highest published build');
    if (BigInt(value) <= BigInt(previous.split('.')[0]!)) throw new Error('MACOS_BUILD_NUMBER must exceed every previously published build');
  }
  return value;
}

export function readPublicKey(path: string): string {
  assertSafePackageFile(path, 'public update key', realpathSync(join(path, '..')));
  const value = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32 || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('Update public key must be canonical Base64 encoding of 32 bytes');
  return value;
}

/** Only the exact versioned Sparkle layout gets a symlink exception. Runtime sources do not. */
export function validateSparkleFramework(root: string): void {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Sparkle framework root must be a physical directory');
  const physicalRoot = realpathSync(root);
  const allowed = new Map(['Autoupdate', 'Headers', 'PrivateHeaders', 'Resources', 'Modules', 'Sparkle', 'Updater.app', 'XPCServices'].map(name => [name, `Versions/Current/${name}`]));
  allowed.set('Versions/Current', 'B');
  const seen = new Set<string>();
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    const rel = relative(root, path).split('\\').join('/');
    if (stat.isSymbolicLink()) {
      if (allowed.get(rel) !== readlinkSync(path)) throw new Error('Unexpected Sparkle framework symlink');
      const target = relative(physicalRoot, realpathSync(path));
      if (target.startsWith('..') || isAbsolute(target)) throw new Error('Sparkle link escapes framework');
      seen.add(rel);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else {
      assertSafePackageFile(path, 'Sparkle framework payload', physicalRoot);
    }
  };
  walk(root);
  for (const name of allowed.keys()) if (!seen.has(name)) throw new Error('Incomplete Sparkle framework links');
  for (const name of ['Sparkle', 'Autoupdate', 'Updater.app/Contents/MacOS/Updater', 'XPCServices/Downloader.xpc/Contents/MacOS/Downloader', 'XPCServices/Installer.xpc/Contents/MacOS/Installer']) {
    const path = join(root, 'Versions/B', name);
    assertSafePackageFile(path, 'Sparkle executable', physicalRoot);
    if (!(lstatSync(path).mode & 0o111)) throw new Error('Sparkle executable permission missing');
  }
}

if (import.meta.main) {
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'framework' && value) validateSparkleFramework(value);
    else if (command === 'key' && value) console.log(readPublicKey(value));
    else if (command === 'release') {
      if (!process.env.MACOS_PREVIOUS_BUILD_NUMBER) throw new Error('MACOS_PREVIOUS_BUILD_NUMBER is required (highest published CFBundleVersion; bootstrap 0.1.6)');
      validateBuildNumber(process.env.MACOS_BUILD_NUMBER, process.env.MACOS_PREVIOUS_BUILD_NUMBER);
      if (!process.env.MACOS_UPDATE_PUBLIC_KEY_FILE) throw new Error('MACOS_UPDATE_PUBLIC_KEY_FILE is required for authenticated updater releases');
      readPublicKey(process.env.MACOS_UPDATE_PUBLIC_KEY_FILE);
    } else if (command === 'build') validateBuildNumber(process.env.MACOS_BUILD_NUMBER);
    else throw new Error('Unknown macOS update packaging validation command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'macOS update packaging validation failed');
    process.exit(1);
  }
}
