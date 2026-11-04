import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeObservation } from './native-observation.mjs';

test('native observation publishes complete snapshots to concurrent real-process readers', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-observation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  writeObservation(path, { calls: 0, padding: 'x'.repeat(16384) });
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeObservation } from ${JSON.stringify(new URL('./native-observation.mjs', import.meta.url).href)};
    for (let calls = 1; calls <= 2000; calls++) writeObservation(${JSON.stringify(path)}, { calls, padding: 'x'.repeat(16384) });
  `], { stdio: 'pipe' });
  t.after(() => { if (writer.exitCode === null) writer.kill(); });
  const exited = once(writer, 'exit');
  let reads = 0;
  while (writer.exitCode === null && writer.signalCode === null) {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(Number.isInteger(state.calls));
    assert.equal(state.padding.length, 16384);
    reads++;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal((await exited)[0], 0);
  assert.ok(reads > 0);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).calls, 2000);
});
