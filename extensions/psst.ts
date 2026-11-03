import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
// Use Pi's injected synchronous loader so /reload refreshes the complete graph.
// Native dynamic import keeps ESM modules cached even when the host reloads.
const { supportedNode, installUnsupportedRuntime } = require('../src/runtime-support.mjs');

export default function (pi: ExtensionAPI) {
  if (!supportedNode()) { installUnsupportedRuntime(pi); return; }
  const { installExtension } = require('../src/extension.mjs');
  installExtension(pi, Type);
}
