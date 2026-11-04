// The default test entry point. Never overlay production code onto the extracted artifact.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { command, json, sha256, sourceIdentity, validateEvidence, validatePackage } from './package-integrity.mjs';

const suites = {
  unit: ['test/*.test.mjs'],
  host: ['test/native-host.probe.mjs', 'test/tool-operation-host.probe.mjs', 'test/native-card-host.probe.mjs', 'test/native-boundary-host.probe.mjs'],
  approval: ['test/approval-native.probe.mjs'],
  native: ['test/upgrade-native.probe.mjs', 'test/authorization-native.probe.mjs', 'test/native-acceptance.probe.mjs', 'test/runtime-native.probe.mjs'],
};
const root = fileURLToPath(new URL('../', import.meta.url));
const options = { suite: 'unit', expectedCommit: process.env.PI_TEST_EXPECTED_COMMIT, artifact: process.env.PI_TEST_ARTIFACT };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = { '--suite': 'suite', '--output': 'output', '--expected-commit': 'expectedCommit', '--artifact': 'artifact' }[process.argv[i]];
  assert.ok(key && process.argv[i + 1], `Unknown or incomplete option: ${process.argv[i]}`);
  options[key] = process.argv[i + 1];
}
assert.ok(suites[options.suite], `Unknown test suite: ${options.suite}`);
const suiteKey = options.suite + (options.suite === 'approval' && process.env.PI_TEST_CONTAINER_IMAGE ? ':container' : '');
const temporary = mkdtempSync(join(tmpdir(), 'pi-package-test-'));
let evidencePath, evidence;
try {
  const identity = sourceIdentity(root, options.expectedCommit);
  let artifact;
  if (options.artifact) {
    artifact = resolve(options.artifact);
    evidencePath = `${artifact}.evidence.json`;
    evidence = json(evidencePath);
    validateEvidence(evidence, artifact, identity);
  } else {
    const destination = options.output ? resolve(options.output) : join(temporary, 'artifact');
    mkdirSync(destination, { recursive: true });
    const [manifest] = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: root }));
    artifact = join(destination, manifest.filename);
    evidencePath = `${artifact}.evidence.json`;
    evidence = { schema: 1, source: identity, artifact: basename(artifact), artifactSha256: sha256(readFileSync(artifact)), suites: {} };
  }
  const unpack = join(temporary, 'unpack');
  mkdirSync(unpack);
  command('tar', ['-xzf', artifact, '-C', unpack]);
  const packed = join(unpack, 'package');
  const packageIdentity = validatePackage(root, packed);
  if (evidence.package) assert.deepEqual(evidence.package, packageIdentity, 'Package contents changed since earlier suite');
  evidence.package = packageIdentity;
  const started = Date.now();
  evidence.suites[suiteKey] = { status: 'running' };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  // Test harness is supplied separately. Nothing from src/, extensions/, vendor/,
  // package.json or shipped docs is copied from the checkout to repair the package.
  for (const entry of ['test', 'scripts', 'package-lock.json']) {
    assert.ok(!existsSync(join(packed, entry)), `Test harness would overwrite a shipped path: ${entry}`);
    cpSync(join(root, entry), join(packed, entry), { recursive: true });
  }
  symlinkSync(join(root, 'node_modules'), join(packed, 'node_modules'), 'dir');
  const env = { ...process.env, PI_TEST_ARTIFACT: artifact };
  // Existing integration settings may be checkout-relative. The test cwd is the artifact.
  for (const key of ['PSST_TEST_SOURCE', 'PI_TEST_INSTALL', 'PI_TEST_OLD_SOURCE', 'PI_TEST_URL_SOURCE', 'PI_TEST_UNSUPPORTED_NODE']) {
    if (env[key]) env[key] = resolve(root, env[key]);
  }
  console.log(`Testing ${packageIdentity.name}@${packageIdentity.version} from ${artifact}\nSource: ${identity.commit ?? 'local files'}${identity.dirty ? ' (working tree)' : ''}; artifact SHA256: ${evidence.artifactSha256}`);
  command(process.execPath, ['--test', ...suites[options.suite]], { cwd: packed, env, stdio: 'inherit', timeout: 180_000 });
  assert.deepEqual(sourceIdentity(root, options.expectedCommit), identity, 'Source changed while tests were running');
  validateEvidence(evidence, artifact, identity);
  for (const [path, hash] of Object.entries(packageIdentity.files)) assert.equal(sha256(readFileSync(join(packed, path))), hash, `Test modified shipped code: ${path}`);
  evidence.suites[suiteKey] = { status: 'passed', durationMs: Date.now() - started };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Verified packed ${options.suite} suite; evidence: ${evidencePath}`);
} catch (error) {
  if (evidencePath && evidence) {
    evidence.suites[suiteKey] = { status: 'failed', error: error.message };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
