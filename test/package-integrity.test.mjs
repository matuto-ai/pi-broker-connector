import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, json, sha256, sourceIdentity, validateEvidence, validatePackage } from '../scripts/package-integrity.mjs';

const put = (root, path, value) => writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-integrity-controls-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), packed = join(root, 'package');
  for (const folder of ['src', 'extensions', 'vendor', 'test', 'scripts']) mkdirSync(join(source, folder), { recursive: true });
  const pkg = { name: '@matuto-ai/pi-psst-connector', version: '12.34.56', engines: { node: '>=24.19.0 <25' }, pi: { extensions: ['./extensions/psst.ts'] }, files: ['src/', 'extensions/', 'vendor/'] };
  put(source, 'package.json', pkg);
  put(source, 'package-lock.json', { name: pkg.name, version: pkg.version, packages: { '': pkg } });
  put(source, 'README.md', 'fixture'); put(source, 'LICENSE', 'fixture');
  put(source, 'extensions/psst.ts', 'export default function() {}');
  put(source, 'vendor/client.mjs', 'export const protocol = 1;');
  put(source, 'src/runtime-support.mjs', `import {readFileSync} from 'node:fs'; export const CONNECTOR_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version; export const NODE_RANGE = '>=24.19.0 <25'; export const runtimeDescription = () => 'Psst connector ' + CONNECTOR_VERSION + ';';`);
  for (const entry of ['package.json', 'README.md', 'LICENSE', 'extensions', 'src', 'vendor']) cpSync(join(source, entry), join(packed, entry), { recursive: true });
  return { root, source, packed, pkg };
}

test('integrity accepts a future package version without changing test constants', t => {
  const f = fixture(t);
  assert.equal(validatePackage(f.source, f.packed).version, '12.34.56');
});
test('negative control: packaged production code cannot be stale even when version matches', t => {
  const f = fixture(t);
  put(f.packed, 'vendor/client.mjs', 'export const protocol = 0;');
  assert.throws(() => validatePackage(f.source, f.packed), /Packed bytes differ.*vendor\/client/);
});
test('negative control: npm files[] cannot silently omit a production module', t => {
  const f = fixture(t);
  for (const root of [f.source, f.packed]) put(root, 'package.json', { ...f.pkg, files: ['extensions/', 'vendor/'] });
  rmSync(join(f.packed, 'src'), { recursive: true });
  assert.throws(() => validatePackage(f.source, f.packed), /Packed file inventory differs/);
});
test('negative control: source and package agreeing on a stale hardcoded runtime still fail', t => {
  const f = fixture(t);
  for (const root of [f.source, f.packed]) put(root, 'src/runtime-support.mjs', "export const CONNECTOR_VERSION='0.0.1'; export const NODE_RANGE='>=24.19.0 <25'; export const runtimeDescription=()=> 'Psst connector 0.0.1;';");
  assert.throws(() => validatePackage(f.source, f.packed), /Loaded runtime reports a stale connector version/);
});
test('negative control: Node gate must agree with advertised package engines', t => {
  const f = fixture(t);
  for (const root of [f.source, f.packed]) {
    const path = join(root, 'src/runtime-support.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace('>=24.19.0 <25', '>=22'));
  }
  assert.throws(() => validatePackage(f.source, f.packed), /Loaded runtime disagrees/);
});
test('negative controls: stale lock and packed versions fail independently', t => {
  const f = fixture(t);
  const lock = json(join(f.source, 'package-lock.json'));
  put(f.source, 'package-lock.json', { ...lock, version: '0.0.1' });
  assert.throws(() => validatePackage(f.source, f.packed), /Package\/lock version mismatch/);
  put(f.source, 'package-lock.json', lock);
  put(f.packed, 'package.json', { ...f.pkg, version: '0.0.1' });
  assert.throws(() => validatePackage(f.source, f.packed), /Package\/lock version mismatch/);
});
test('negative control: accidental test/source overlay in artifact is rejected', t => {
  const f = fixture(t);
  mkdirSync(join(f.packed, 'test')); put(f.packed, 'test/stale.test.mjs', '');
  assert.throws(() => validatePackage(f.source, f.packed), /Packed file inventory differs/);
});
test('negative controls: reused artifact cannot come from another head, dirty tree, or tarball', t => {
  const f = fixture(t), artifact = join(f.root, 'artifact.tgz');
  writeFileSync(artifact, 'tarball fixture');
  const source = { commit: 'a'.repeat(40), dirty: false, sourceSha256: 'b'.repeat(64) };
  const evidence = { source, artifactSha256: sha256(readFileSync(artifact)) };
  validateEvidence(evidence, artifact, source);
  for (const changed of [{ ...source, commit: 'c'.repeat(40) }, { ...source, sourceSha256: 'd'.repeat(64) }, { ...source, dirty: true }]) assert.throws(() => validateEvidence(evidence, artifact, changed), /different commit or source tree/);
  writeFileSync(artifact, 'changed tarball');
  assert.throws(() => validateEvidence(evidence, artifact, source), /tarball changed/);
});
test('negative controls: exact CI commit rejects dirty checkout, new files, and wrong revision', t => {
  const f = fixture(t);
  command('git', ['init', '-q'], { cwd: f.source });
  command('git', ['add', '.'], { cwd: f.source });
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: f.source });
  const identity = sourceIdentity(f.source);
  assert.equal(sourceIdentity(f.source, identity.commit).dirty, false);
  assert.throws(() => sourceIdentity(f.source, '0'.repeat(40)), /not the expected CI commit/);
  put(f.source, 'new-input.txt', 'uncommitted');
  assert.throws(() => sourceIdentity(f.source, identity.commit), /requires a clean checkout/);
  rmSync(join(f.source, 'new-input.txt'));
  put(f.source, 'vendor/client.mjs', 'changed');
  assert.throws(() => sourceIdentity(f.source, identity.commit), /requires a clean checkout/);
  assert.notEqual(sourceIdentity(f.source).sourceSha256, identity.sourceSha256);
});
