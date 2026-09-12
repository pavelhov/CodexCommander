import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublicKey, validateBuildNumber, validateSparkleFramework } from '../scripts/macos-update-packaging';
import { restorePreviousFeedItems, assertPreservedFeedEnclosures, validateFeedAssets, verifyFeed, verifySignature } from '../scripts/macos-appcast';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
function signedFeed(content: string): Buffer {
  const data = Buffer.from(content);
  return Buffer.concat([data, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${sign(null, data, pair.privateKey).toString('base64')}\nlength: ${data.length}\n-->\n`)]);
}
function fixture(body: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'ccx-appcast-'));
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
describe('authenticated macOS release assets', () => {
  test('requires distinct positive integer builds and supports legacy bootstrap ordering', () => {
    for (const value of [undefined, '', '0', '-1', '1.2.3', '01', '1e3', '1000000000000000']) expect(() => validateBuildNumber(value)).toThrow();
    expect(validateBuildNumber('1', '0.1.6')).toBe('1');
    expect(validateBuildNumber('100', '99')).toBe('100');
    for (const value of ['98', '99']) expect(() => validateBuildNumber(value, '99')).toThrow('exceed');
  });
  test('release preflight fails closed without key or baseline and on reused builds', () => fixture(root => {
    const key = join(root, 'release-public'); writeFileSync(key, publicKey);
    const run = (overrides: Record<string, string>) => {
      const env = { ...process.env, MACOS_BUILD_NUMBER: '101', MACOS_PREVIOUS_BUILD_NUMBER: '100', MACOS_UPDATE_PUBLIC_KEY_FILE: key, ...overrides };
      return Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/macos-update-packaging.ts'), 'release'], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode;
    };
    expect(run({})).toBe(0);
    expect(run({ MACOS_UPDATE_PUBLIC_KEY_FILE: '' })).not.toBe(0);
    expect(run({ MACOS_PREVIOUS_BUILD_NUMBER: '' })).not.toBe(0);
    expect(run({ MACOS_BUILD_NUMBER: '100' })).not.toBe(0);
    expect(run({ MACOS_BUILD_NUMBER: '' })).not.toBe(0);
  }));
  test('accepts only canonical public key files; no fixture is a production trust anchor', () => fixture(root => {
    const key = join(root, 'public');
    writeFileSync(key, publicKey + '\n');
    expect(readPublicKey(key)).toBe(publicKey);
    writeFileSync(key, 'not a key');
    expect(() => readPublicKey(key)).toThrow();
    if (process.platform !== 'win32') {
      symlinkSync(key, join(root, 'link'));
      expect(() => readPublicKey(join(root, 'link'))).toThrow();
    }
  }));
  test('rejects unsigned, tampered, truncated, or wrong-key feed before parsing', () => {
    const content = '<rss><channel><title>é</title></channel></rss>';
    const feed = signedFeed(content);
    expect(verifyFeed(feed, publicKey).toString()).toBe(content);
    expect(() => verifyFeed(Buffer.from(content), publicKey)).toThrow('Signed');
    const tampered = Buffer.from(feed); tampered[1] = 88;
    expect(() => verifyFeed(tampered, publicKey)).toThrow('verification');
    expect(() => verifyFeed(feed.subarray(0, feed.length - 4), publicKey)).toThrow();
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    expect(() => verifyFeed(feed, other)).toThrow('verification');
  });
  test('rejects tampered archives independently of the feed', () => {
    const archive = Buffer.from('final archive');
    const signature = sign(null, archive, pair.privateKey).toString('base64');
    expect(() => verifySignature(archive, signature, publicKey)).not.toThrow();
    expect(() => verifySignature(Buffer.from('changed archive'), signature, publicKey)).toThrow();
  });
  test.skipIf(process.platform !== 'darwin')('changing release tags preserves prior immutable enclosure URLs and signatures', () => {
    const item = (build: string, tag: string, signature = 'fixture-signature') => `<item><sparkle:version>${build}</sparkle:version><enclosure url="https://github.com/pavelhov/CodexCommander/releases/download/${tag}/CodexCommander-${build}-macos-universal.zip" sparkle:edSignature="${signature}" length="100" /></item>`;
    const feed = (items: string) => signedFeed(`<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items}</channel></rss>`);
    const previous = feed(item('102', 'v0.1.6'));
    expect(() => assertPreservedFeedEnclosures(previous, feed(item('103', 'v0.1.7') + item('102', 'v0.1.6')), publicKey)).not.toThrow();
    expect(() => assertPreservedFeedEnclosures(previous, feed(item('103', 'v0.1.7') + item('102', 'v0.1.7')), publicKey)).toThrow('enclosure');
    const restored = restorePreviousFeedItems(previous, feed(item('103', 'v0.1.7') + item('102', 'v0.1.7')), publicKey);
    expect(() => assertPreservedFeedEnclosures(previous, signedFeed(restored.toString()), publicKey)).not.toThrow();

    expect(() => assertPreservedFeedEnclosures(previous, feed(item('102', 'v0.1.6', 'changed-signature')), publicKey)).toThrow('enclosure');
  });
  test.skipIf(process.platform !== 'darwin')('verifies all draft assets and rejects missing, mutable, duplicate, or corrupted assets', () => fixture(root => {
    const archive = Buffer.from('fixture final archive');
    const name = 'CodexCommander-0.1.7-7-macos-universal.zip';
    const signature = sign(null, archive, pair.privateKey).toString('base64');
    const item = `<item><sparkle:version>7</sparkle:version><enclosure url="https://github.com/pavelhov/CodexCommander/releases/download/v0.1.7/${name}" sparkle:edSignature="${signature}" length="${archive.length}" /></item>`;
    const save = (items: string) => writeFileSync(join(root, 'appcast.xml'), signedFeed(`<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items}</channel></rss>`));
    save(item);
    expect(() => validateFeedAssets(root, publicKey)).toThrow();
    writeFileSync(join(root, name), archive);
    expect(validateFeedAssets(root, publicKey)).toEqual(['7']);
    save(item + item);
    expect(() => validateFeedAssets(root, publicKey)).toThrow('Duplicate');
    save(item.replace('download/v0.1.7', 'latest/download'));
    expect(() => validateFeedAssets(root, publicKey)).toThrow('immutable');
    save(item); writeFileSync(join(root, name), Buffer.from('fixture WRONG archive'));
    expect(() => validateFeedAssets(root, publicKey)).toThrow();
  }));
  test.skipIf(process.platform === 'win32')('framework exception preserves only exact Sparkle links and executable helpers', () => fixture(root => {
    const framework = join(root, 'Sparkle.framework');
    const version = join(framework, 'Versions/B');
    mkdirSync(version, { recursive: true });
    for (const dir of ['Headers', 'PrivateHeaders', 'Resources', 'Modules', 'Updater.app', 'XPCServices']) mkdirSync(join(version, dir));
    for (const executable of ['Sparkle', 'Autoupdate', 'Updater.app/Contents/MacOS/Updater', 'XPCServices/Downloader.xpc/Contents/MacOS/Downloader', 'XPCServices/Installer.xpc/Contents/MacOS/Installer']) {
      const path = join(version, executable); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'fixture'); chmodSync(path, 0o755);
    }
    for (const name of ['Autoupdate', 'Headers', 'PrivateHeaders', 'Resources', 'Modules', 'Sparkle', 'Updater.app', 'XPCServices']) symlinkSync(`Versions/Current/${name}`, join(framework, name));
    symlinkSync('B', join(framework, 'Versions/Current'));
    expect(() => validateSparkleFramework(framework)).not.toThrow();
    chmodSync(join(version, 'Autoupdate'), 0o644);
    expect(() => validateSparkleFramework(framework)).toThrow('permission');
    chmodSync(join(version, 'Autoupdate'), 0o755);
    symlinkSync('/etc/passwd', join(version, 'Resources/extra'));
    expect(() => validateSparkleFramework(framework)).toThrow('Unexpected');
  }));
});
