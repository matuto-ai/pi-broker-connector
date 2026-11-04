import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConnectionFile } from '../src/connect-config.mjs';
test('one connect path accepts legacy bundle unchanged or private pairing file through shared helper',async t=>{
 const root=mkdtempSync(join(tmpdir(),'pi-pair-glue-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=join(root,'input.json'),env={PSST_STATE_DIR:join(root,'state')};let calls=0;
 const pairingConnector=async options=>{calls++;assert.deepEqual(options,{pairingFile:file,directory:join(root,'state/installations'),clientType:'pi'});return {connectionFile:join(root,'issued/connection.json'),credentialId:'fixture',expiresAt:'fixture'};};
 writeFileSync(file,JSON.stringify({format:'broker-client-bundle-v1'}),{mode:0o600});assert.equal(await resolveConnectionFile(file,{env,pairingConnector}),file);assert.equal(calls,0);
 writeFileSync(file,JSON.stringify({format:'psst-pairing-v1'}));assert.equal(await resolveConnectionFile(file,{env,pairingConnector}),join(root,'issued/connection.json'));assert.equal(calls,1);
 await assert.rejects(resolveConnectionFile(file,{env,pairingConnector:async()=>{throw Error('sanitized');}}),{code:'invalid_configuration'});
});
