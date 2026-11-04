import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000, ...options });
  assert.equal(result.status, 0, `${program} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
  return result.stdout;
}
function filesUnder(root, path) {
  const absolute = join(root, path);
  assert.ok(existsSync(absolute), `Missing package input: ${path}`);
  const stat = lstatSync(absolute);
  assert.ok(!stat.isSymbolicLink(), `Package input must not be a symlink: ${path}`);
  if (stat.isFile()) return [path];
  assert.ok(stat.isDirectory(), `Unsupported package input: ${path}`);
  return readdirSync(absolute).sort().flatMap(name => filesUnder(root, `${path}/${name}`));
}
export function sourceIdentity(root, expectedCommit) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const commit = revision.status === 0 ? revision.stdout.trim() : null;
  if (expectedCommit) assert.equal(commit, expectedCommit, 'Checkout is not the expected CI commit');
  const status = commit ? command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root }).trim() : 'No Git checkout';
  if (expectedCommit) assert.equal(status, '', 'Exact-commit verification requires a clean checkout');
  const inputs = commit
    ? command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).split('\0').filter(Boolean)
    : ['package.json', 'package-lock.json', 'src', 'extensions', 'vendor', 'test', 'scripts'].flatMap(path => filesUnder(root, path));
  const hashes = [...new Set(inputs)].sort().map(path => [path, existsSync(join(root, path)) ? sha256(readFileSync(join(root, path))) : null]);
  return { commit, dirty: Boolean(status), sourceSha256: sha256(JSON.stringify(hashes)) };
}
export function packageFiles(root) {
  const pkg = json(join(root, 'package.json'));
  assert.ok(Array.isArray(pkg.files), 'package.json must explicitly list shipped files');
  // These are production entry points, even if accidentally removed from files[].
  const entries = new Set(['package.json', 'README.md', 'LICENSE', 'src', 'extensions', 'vendor', ...pkg.files.map(path => path.replace(/\/$/, ''))]);
  for (const path of entries) assert.ok(path && !path.includes('..') && !path.startsWith('/') && !/[?*]/.test(path), `Unsupported package file pattern: ${path}`);
  return [...new Set([...entries].flatMap(path => filesUnder(root, path)))].sort();
}
export function validatePackage(source, packed) {
  const expected = json(join(source, 'package.json'));
  const lock = json(join(source, 'package-lock.json'));
  const actual = json(join(packed, 'package.json'));
  for (const manifest of [lock, lock.packages[''], actual]) {
    assert.equal(manifest.name, expected.name, 'Package/lock name mismatch');
    assert.equal(manifest.version, expected.version, 'Package/lock version mismatch');
  }
  assert.equal(lock.packages[''].engines.node, expected.engines.node, 'Package/lock Node range mismatch');
  const files = packageFiles(source);
  const actualFiles = readdirSync(packed).sort().flatMap(path => filesUnder(packed, path)).sort();
  assert.deepEqual(actualFiles, files, 'Packed file inventory differs from the current production inputs');
  const hashes = {};
  for (const path of files) {
    const original = readFileSync(join(source, path));
    const shipped = readFileSync(join(packed, path));
    assert.ok(original.equals(shipped), `Packed bytes differ from current source: ${path}`);
    hashes[path] = sha256(shipped);
  }
  for (const entry of expected.pi.extensions) {
    assert.ok(files.includes(relative(source, resolve(source, entry))), `Pi entry point missing from package: ${entry}`);
  }
  const runtimeUrl = pathToFileURL(join(packed, 'src/runtime-support.mjs')).href;
  const runtime = JSON.parse(command(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(runtimeUrl)}); console.log(JSON.stringify({ version: m.CONNECTOR_VERSION, range: m.NODE_RANGE, description: m.runtimeDescription() }));`]));
  assert.equal(runtime.version, expected.version, 'Loaded runtime reports a stale connector version');
  assert.equal(runtime.range, expected.engines.node, 'Loaded runtime disagrees with package Node range');
  assert.ok(runtime.description.includes(`Psst connector ${expected.version};`), 'Runtime diagnostic reports a stale connector version');
  return { name: expected.name, version: expected.version, files: hashes };
}
export function validateEvidence(evidence, artifact, identity) {
  assert.equal(evidence.artifactSha256, sha256(readFileSync(artifact)), 'Package tarball changed since it was built');
  assert.deepEqual(evidence.source, identity, 'Package was built from a different commit or source tree');
}
