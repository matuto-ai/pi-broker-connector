import test from 'node:test';
import assert from 'node:assert/strict';
import { installExtension } from '../src/extension.mjs';

const Type = {
  Object: (properties, options) => ({ type: 'object', properties, ...options }),
  String: options => ({ type: 'string', ...options }),
  Optional: type => ({ ...type, optional: true }),
  Integer: options => ({ type: 'integer', ...options }),
  Boolean: () => ({ type: 'boolean' }),
};

test('native tool schemas bound discovery and keep send identity internal', () => {
  const tools = {};
  installExtension({ on() {}, registerCommand() {}, registerTool: tool => tools[tool.name] = tool }, Type,
    { env: {}, pathStore: { read: () => null } });
  const discovery = tools.broker_list_clients.parameters;
  assert.equal(discovery.additionalProperties, false);
  assert.deepEqual(discovery.properties.connected, { type: 'boolean', optional: true });
  assert.deepEqual(discovery.properties.limit, { type: 'integer', minimum: 1, maximum: 100, optional: true });
  assert.deepEqual(discovery.properties.cursor, { type: 'string', optional: true });
  assert.equal(tools.broker_send.parameters.additionalProperties, false);
  assert.equal(tools.broker_send.parameters.properties.send_key, undefined);
  assert.equal(tools.broker_receive, undefined);
  assert.equal(tools.broker_acknowledge, undefined);
});
