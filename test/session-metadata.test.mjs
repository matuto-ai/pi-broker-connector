import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSessionMetadata, metadataSummary } from '../src/session-metadata.mjs';
import { validateMetadata } from '../vendor/broker/src/protocol.mjs';

const model = { provider: 'fixture-provider', id: 'fixture-model' };
function nativeContext(id, name = 'Review', cwd = '/private/parent/project', selected = model) {
  const ctx = { name, cwd, model: selected, hasUI: false };
  ctx.sessionManager = { getSessionId: () => id, getSessionName: () => ctx.name };
  return ctx;
}

test('native metadata observes supported APIs, stable labels, project basename and selected model only', () => {
  const ctx = nativeContext('session-a');
  const identity = { clientId: '12345678-0000-4000-8000-000000000000' };
  const metadata = nativeSessionMetadata({}, ctx, identity);
  assert.deepEqual(metadata, { name: 'Review [12345678]', project: 'project',
    model: { ...model, source: 'observed' } });
  assert.deepEqual(validateMetadata(metadata), metadata);
  assert.equal(metadataSummary(metadata), 'Review [12345678]; project project; model fixture-model');
  assert.ok(!JSON.stringify(metadata).includes('/private/parent'));
  assert.notEqual(nativeSessionMetadata({}, ctx, { clientId: '87654321-0000-4000-8000-000000000000' }).name, metadata.name);
  ctx.name = 'Renamed'; ctx.model = { provider: 'other-provider', id: 'other-model' };
  assert.equal(nativeSessionMetadata({}, ctx, identity).name, 'Renamed [12345678]');
  assert.deepEqual(nativeSessionMetadata({}, ctx, identity).model, { ...ctx.model, source: 'observed' });
  assert.equal(nativeSessionMetadata({}, ctx, { ...identity, nameOverride: 'Operator label' }).name, 'Operator label [12345678]');
  assert.deepEqual(ctx.model, { provider: 'other-provider', id: 'other-model' }, 'observation must not alter the native model');
});

test('unnamed/unavailable host metadata is truthful, bounded and terminal-safe', () => {
  const ctx = nativeContext('session-fallback', undefined, undefined, undefined);
  delete ctx.name; delete ctx.cwd; delete ctx.model;
  const first = nativeSessionMetadata({}, ctx);
  assert.match(first.name, /^Pi \[[a-f0-9]{8}\]$/);
  assert.equal(first.name, nativeSessionMetadata({}, ctx).name);
  assert.deepEqual(first.model, { provider: null, id: null, source: 'unknown' });
  assert.equal(first.project, null);
  assert.equal(nativeSessionMetadata({ getSessionName: () => 'API name' }, ctx).name.split(' [')[0], 'API name');
  ctx.name = '\u001b[31m\u202e' + '😀'.repeat(150); ctx.cwd = 'C:\\private\\project';
  ctx.model = { provider: 'x\nprovider', id: 'm\u009bodel' };
  const safe = nativeSessionMetadata({}, ctx);
  assert.equal(safe.project, 'project');
  assert.equal([...safe.name].length, 128);
  assert.doesNotMatch(JSON.stringify(safe), /\u001b|\u202e|\u009b/);
  assert.doesNotThrow(() => validateMetadata(safe));
  assert.equal(nativeSessionMetadata({}, { ...ctx, cwd: '/' }).project, null);
  assert.equal(nativeSessionMetadata({}, { ...ctx, model: { provider: 'only-provider' } }).model.source, 'unknown');
  const broken = { get cwd() { throw Error('host unavailable'); }, get model() { throw Error('host unavailable'); }, sessionManager: {} };
  assert.doesNotThrow(() => validateMetadata(nativeSessionMetadata({}, broken)));
});
