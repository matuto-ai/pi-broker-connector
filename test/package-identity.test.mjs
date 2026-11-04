import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONNECTOR_VERSION, NODE_RANGE } from '../src/runtime-support.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('npm package, lockfile, and documented installation use the matuto-ai scope', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, '@matuto-ai/pi-psst-connector');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(CONNECTOR_VERSION, pkg.version);
  assert.equal(NODE_RANGE, pkg.engines.node);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.repository.url, 'git+https://github.com/matuto-ai/pi-psst-connector.git');
  const docs = read('README.md');
  assert.ok(docs.includes(`pi install npm:${pkg.name}@${pkg.version}`));
  assert.ok(!docs.includes('@brunoorsolon/'));
});

test('0.6.0 migration preserves the native Pi entry and documents explicit source switching', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.pi.extensions, ['./extensions/psst.ts']);
  assert.ok(pkg.files.includes('docs/migration-0.6.0.md'));
  const migration = read('docs/migration-0.6.0.md');
  assert.ok(migration.includes('@matuto-ai/pi-broker-connector'));
  assert.ok(migration.includes('does not switch names automatically'));
  assert.ok(migration.includes('npm-publish.yml'));
});
