import { createPublicKey, verify, createHash } from 'node:crypto';
import { lstatSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, copyFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPublicKey, validateBuildNumber } from './macos-update-packaging';
import { assertSafePackageFile, assertSafePackageTree } from './package-tree-safety';

const toolHashes: Record<string, string> = {
  generate_appcast: 'b3b54ba3fb85ef1f25eb2f5a9ad90c32ba6e71af777b181c50ffb5d860bac6b7',
  sign_update: 'bfb52400c3da18bb4c251ac4818c2c2e1e31c2e649a45b31c11109b6e57b34ad',
};
export function verifySignature(data: Buffer, signature: string, publicKey: string): void {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid Ed25519 signature encoding');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  if (!verify(null, data, key, Buffer.from(signature, 'base64'))) throw new Error('Update signature verification failed');
}
export function verifyFeed(data: Buffer, publicKey: string): Buffer {
  const marker = Buffer.from('<!-- sparkle-signatures:\n');
  const index = data.lastIndexOf(marker);
  if (index < 0) throw new Error('Signed appcast is required');
  const match = /^<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/=]+)\nlength: ([0-9]+)\n-->\s*$/.exec(data.subarray(index).toString('utf8'));
  if (!match || BigInt(match[2]!) !== BigInt(index)) throw new Error('Invalid signed appcast length or trailer');
  const content = data.subarray(0, index);
  verifySignature(content, match[1]!, publicKey);
  return content;
}

// Foundation/Python XML parser semantics, not regex parsing, for signed release metadata.
function parseItems(content: Buffer): Array<{ build: string; url: string; signature: string; length: string }> {
  const result = Bun.spawnSync(['python3', '-c', `import sys,json,xml.etree.ElementTree as E
s=sys.stdin.buffer.read()
if b'<!DOCTYPE' in s or b'<!ENTITY' in s: raise ValueError('DTD not allowed')
r=E.fromstring(s)
ns={'s':'http://www.andymatuschak.org/xml-namespaces/sparkle'}
items=[]
for i in r.findall('./channel/item'):
 e=i.find('enclosure')
 if e is None or i.find('s:channel',ns) is not None: raise ValueError('stable full archives required')
 items.append(dict(build=i.findtext('s:version',default='',namespaces=ns),url=e.get('url',''),signature=e.get('{'+ns['s']+'}edSignature',''),length=e.get('length','')))
if not items: raise ValueError('empty appcast')
print(json.dumps(items))`], { stdin: content, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Appcast XML is invalid or has no stable full update items (python3 required)');
  return JSON.parse(result.stdout.toString());
}

/** generate_appcast applies its current URL prefix to older items too. Restore
 * authenticated prior items before signing the final feed for publication. */
export function restorePreviousFeedItems(previous: Buffer, generated: Buffer, publicKey: string): Buffer {
  const oldXML = verifyFeed(previous, publicKey).toString('utf8');
  const newXML = verifyFeed(generated, publicKey).toString('utf8');
  const result = Bun.spawnSync(['python3', '-c', `import sys,json,copy,xml.etree.ElementTree as E
old,new=json.load(sys.stdin)
if any(x in s for s in [old,new] for x in ['<!DOCTYPE','<!ENTITY']): raise ValueError('DTD not allowed')
ns={'s':'http://www.andymatuschak.org/xml-namespaces/sparkle'}
E.register_namespace('sparkle',ns['s'])
a=E.fromstring(old); b=E.fromstring(new); channel=b.find('channel')
prior={i.findtext('s:version',namespaces=ns):i for i in a.findall('./channel/item')}
for i in list(channel):
 if i.tag != 'item': continue
 v=i.findtext('s:version',namespaces=ns)
 if v in prior:
  position=list(channel).index(i)
  channel.remove(i); channel.insert(position,copy.deepcopy(prior.pop(v)))
if prior: raise ValueError('previous item disappeared')
sys.stdout.buffer.write(E.tostring(b,encoding='utf-8',xml_declaration=True))`], { stdin: Buffer.from(JSON.stringify([oldXML, newXML])), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Cannot restore authenticated previous appcast items');
  return result.stdout;
}

/** A new release tag must never retarget already published archive URLs. */
export function assertPreservedFeedEnclosures(previous: Buffer, next: Buffer, publicKey: string): void {
  const priorItems = parseItems(verifyFeed(previous, publicKey));
  const nextItems = parseItems(verifyFeed(next, publicKey));
  for (const prior of priorItems) {
    const retained = nextItems.find(item => item.build === prior.build);
    if (!retained || retained.url !== prior.url || retained.signature !== prior.signature || retained.length !== prior.length) {
      throw new Error('Previous immutable appcast enclosure changed or disappeared');
    }
  }
}

export function validateFeedAssets(directory: string, publicKey: string): string[] {
  const items = parseItems(verifyFeed(readFileSync(join(directory, 'appcast.xml')), publicKey));
  const builds = new Set<string>();
  for (const item of items) {
    validateBuildNumber(item.build);
    if (builds.has(item.build)) throw new Error('Duplicate update build');
    builds.add(item.build);
    if (!/^https:\/\/github\.com\/pavelhov\/CodexCommander\/releases\/download\/v[0-9][A-Za-z0-9.-]*\/CodexCommander-[A-Za-z0-9.-]+-macos-universal\.zip$/.test(item.url)) throw new Error('Archive URL must identify an immutable universal GitHub release asset');
    const path = join(directory, new URL(item.url).pathname.split('/').pop()!);
    assertSafePackageFile(path, 'final update archive', realpathSync(directory));
    const data = readFileSync(path);
    if (String(data.length) !== item.length) throw new Error('Archive length mismatch');
    verifySignature(data, item.signature, publicKey);
  }
  return [...builds];
}

function validateArchiveMetadata(path: string, publicKey: string, build: string, version: string): void {
  const infoPath = 'CodexCommander.app/Contents/Info.plist';
  const archive = Bun.spawnSync(['unzip', '-p', path, infoPath], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  if (archive.exitCode !== 0 || archive.stdout.length > 64 * 1024) throw new Error('Missing or oversized archive Info.plist');
  const get = (key: string): string => {
    const result = Bun.spawnSync(['plutil', '-extract', key, 'raw', '-o', '-', '-'], { stdin: archive.stdout, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('Archive updater metadata is incomplete');
    return result.stdout.toString().trim();
  };
  const required: Record<string, string> = {
    CFBundleIdentifier: 'com.codexcommander.menubar', CFBundleVersion: build,
    CFBundleShortVersionString: version, LSMinimumSystemVersion: '13.0', SUPublicEDKey: publicKey,
    CodexCommanderUpdaterEnabled: 'true', SURequireSignedFeed: 'true',
    SUVerifyUpdateBeforeExtraction: 'true', SUSignedFeedFailureExpirationInterval: '0',
    SUAllowsAutomaticUpdates: 'false',
    SUFeedURL: 'https://github.com/pavelhov/CodexCommander/releases/latest/download/appcast.xml',
  };
  for (const [key, expected] of Object.entries(required)) if (get(key) !== expected) throw new Error('Archive identity, build, or strict updater policy does not match release configuration');
}

function main(): void {
  const [mode, directoryArg] = process.argv.slice(2);
  if (!['--generate', '--verify'].includes(mode ?? '') || !directoryArg) throw new Error('Usage: generate-macos-appcast.sh --generate|--verify <asset-directory>');
  const directory = realpathSync(directoryArg);
  const keyPath = process.env.MACOS_UPDATE_PUBLIC_KEY_FILE;
  if (!keyPath) throw new Error('MACOS_UPDATE_PUBLIC_KEY_FILE is required');
  const publicKey = readPublicKey(keyPath);
  if (mode === '--verify') {
    validateFeedAssets(directory, publicKey);
    console.log('Signed feed and every referenced archive verified; no publication performed.');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Appcast generation requires macOS');
  const build = validateBuildNumber(process.env.MACOS_BUILD_NUMBER, process.env.MACOS_PREVIOUS_BUILD_NUMBER);
  if (!process.env.MACOS_PREVIOUS_BUILD_NUMBER) throw new Error('MACOS_PREVIOUS_BUILD_NUMBER is required');
  const version = process.env.RELEASE_VERSION;
  if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('RELEASE_VERSION must identify a stable release');
  const toolDir = process.env.SPARKLE_TOOLS_DIR;
  if (!toolDir) throw new Error('SPARKLE_TOOLS_DIR must contain official Sparkle 2.9.6 release tools');
  for (const [tool, hash] of Object.entries(toolHashes)) {
    const path = join(toolDir, tool);
    assertSafePackageFile(path, 'pinned Sparkle tool', realpathSync(toolDir));
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) throw new Error('Sparkle 2.9.6 tool checksum mismatch');
  }
  const privatePath = process.env.SPARKLE_PRIVATE_KEY_FILE;
  if (!privatePath) throw new Error('SPARKLE_PRIVATE_KEY_FILE is required; key material is never accepted in command arguments');
  const privateStat = lstatSync(privatePath);
  if (!privateStat.isFile() || privateStat.isSymbolicLink() || privateStat.nlink !== 1 || (privateStat.mode & 0o077)) throw new Error('Private update key must be a single-link physical file with mode 0600 or stricter');
  // Forbid durable source custody. Ephemeral fixtures may live in ignored .tmp only.
  const repo = resolve(import.meta.dir, '..');
  const physicalKey = realpathSync(privatePath);
  if (physicalKey.startsWith(repo + '/') && !physicalKey.startsWith(join(repo, '.tmp') + '/')) throw new Error('Private signing key must be outside the source tree');
  assertSafePackageTree(directory, 'release assets', directory);
  const previous = join(directory, 'appcast.xml');
  let previousBuilds: string[] = [];
  if (Bun.file(previous).size > 0) {
    previousBuilds = validateFeedAssets(directory, publicKey);
    for (const prior of previousBuilds) validateBuildNumber(build, prior);
  } else if (process.env.MACOS_PREVIOUS_BUILD_NUMBER !== '0.1.6') {
    throw new Error('An authenticated previous appcast is required after the 0.1.6 bootstrap');
  }
  validateArchiveMetadata(join(directory, `CodexCommander-${version}-${build}-macos-universal.zip`), publicKey, build, version);
  const stage = mkdtempSync(join(directory, '.appcast-stage-'));
  try {
    const hashes = new Map<string, string>();
    for (const name of readdirSync(directory)) {
      if (!/\.(zip|xml|html|md|txt)$/.test(name)) continue;
      const path = join(directory, name);
      assertSafePackageFile(path, 'release input', directory);
      copyFileSync(path, join(stage, name));
      if (name.endsWith('.zip')) hashes.set(name, createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
    const result = Bun.spawnSync([join(toolDir, 'generate_appcast'), '--ed-key-file', '-', '--download-url-prefix', `https://github.com/pavelhov/CodexCommander/releases/download/v${version}/`, '--versions', build, '--maximum-versions', '0', '--maximum-deltas', '0', '--embed-release-notes', stage], {
      stdin: readFileSync(privatePath), stdout: 'pipe', stderr: 'pipe', timeout: 300_000,
    });
    // Upstream output may contain local paths. Do not echo it or private material.
    if (result.exitCode !== 0) throw new Error('Pinned Sparkle appcast generation failed; confirm archive metadata, signing key, and tool installation');
    if (previousBuilds.length > 0) {
      const stagedFeed = join(stage, 'appcast.xml');
      writeFileSync(stagedFeed, restorePreviousFeedItems(readFileSync(previous), readFileSync(stagedFeed), publicKey));
      const signed = Bun.spawnSync([join(toolDir, 'sign_update'), '--ed-key-file', '-', stagedFeed], {
        stdin: readFileSync(privatePath), stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      });
      if (signed.exitCode !== 0) throw new Error('Pinned Sparkle final appcast signing failed');
    }
    const builds = validateFeedAssets(stage, publicKey);
    if (previousBuilds.length > 0) assertPreservedFeedEnclosures(readFileSync(previous), readFileSync(join(stage, 'appcast.xml')), publicKey);
    if (!builds.includes(build) || previousBuilds.some(prior => !builds.includes(prior))) throw new Error('Appcast did not preserve previous builds and include the requested target');
    for (const [name, hash] of hashes) {
      if (createHash('sha256').update(readFileSync(join(stage, name))).digest('hex') !== hash || createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') !== hash) throw new Error('Final archive changed during appcast generation');
    }
    renameSync(join(stage, 'appcast.xml'), previous);
    console.log('Prepared authenticated appcast.xml. Run --verify, then assemble and verify the complete draft release before publishing as latest.');
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Appcast preparation failed'); process.exit(1); }
}
