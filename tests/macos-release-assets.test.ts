import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../scripts/package-macos-release.sh');
function run(stage: string, output: string) {
  return Bun.spawnSync(['bash', '-c', 'source "$1"; install_release_assets "$2" "$3" archive.zip archive.zip.sha256', 'fixture', script, stage, output], { stdout: 'pipe', stderr: 'pipe' });
}
test.skipIf(process.platform !== 'darwin')('release output installation rejects links and never overwrites immutable assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccx-release-assets-'));
  try {
    const stage = join(root, 'stage'); const output = join(root, 'output'); mkdirSync(stage); mkdirSync(output);
    writeFileSync(join(stage, 'archive.zip'), 'complete archive'); writeFileSync(join(stage, 'archive.zip.sha256'), 'complete checksum');
    for (const name of ['archive.zip', 'archive.zip.sha256']) {
      const external = join(root, `outside-${name}`); symlinkSync(external, join(output, name));
      const result = run(stage, output);
      expect(result.exitCode).not.toBe(0); expect(result.stderr.toString()).toContain('immutable release assets');
      expect(existsSync(external)).toBe(false);
      expect(existsSync(join(output, name === 'archive.zip' ? 'archive.zip.sha256' : 'archive.zip'))).toBe(false);
      rmSync(join(output, name));
    }
    expect(run(stage, output).exitCode).toBe(0);
    expect(readFileSync(join(output, 'archive.zip'), 'utf8')).toBe('complete archive');
    expect(readFileSync(join(output, 'archive.zip.sha256'), 'utf8')).toBe('complete checksum');
    writeFileSync(join(stage, 'archive.zip'), 'new archive');
    writeFileSync(join(stage, 'archive.zip.sha256'), 'new checksum');
    expect(run(stage, output).exitCode).not.toBe(0);
    expect(readFileSync(join(output, 'archive.zip'), 'utf8')).toBe('complete archive');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
