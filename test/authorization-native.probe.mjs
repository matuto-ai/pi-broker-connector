// Bundled official native dialogs, real admin denial and verified loopback TLS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createConfigPathStore} from '../src/config-path.mjs';
import {readConfig} from '../src/config.mjs';
const host=process.env.PI_TEST_INSTALL,source=process.env.PSST_TEST_SOURCE;
if(!host||!source)throw Error('Set PI_TEST_INSTALL and PSST_TEST_SOURCE to pinned fixtures');
const {approvalTlsFixture}=await import(pathToFileURL(join(resolve(source),'test/approval-tls-fixture.mjs')));
test('native replacement cancel, real denial and reload preserve working installation',{timeout:60000},async t=>{
 const f=await approvalTlsFixture(t),agent=join(f.directory,'agent');
 const options={brokerUrl:f.brokerUrl,directory:join(agent,'psst/installation-credentials'),clientType:'pi'};
 const pending=await f.helper('beginApproval',options);await f.decide(pending.requestId,'approve');const approved=await f.helper('pollApproval',options);
 const config=readConfig({PI_CODING_AGENT_DIR:agent},approved.connectionFile),credential=readFileSync(config.tokenFile);
 const control={directory:f.directory,brokerUrl:f.brokerUrl,connectionFile:approved.connectionFile,cert:f.certFile,extension:resolve('extensions/psst.ts'),piCli:join(resolve(host),'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')};
 const file=join(f.directory,'control.json');writeFileSync(file,JSON.stringify(control));
 const child=spawn('python3',['scripts/authorization-native-pty.py',file],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
 let partial='',stderr='',work=Promise.resolve(),failure,selection,identity,replacement;const events=[];
 const pathStore=createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:agent});
 child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',b=>{partial+=b;const lines=partial.split('\n');partial=lines.pop();for(const line of lines)if(line)work=work.then(async()=>{
  const {event}=JSON.parse(line);events.push(event);if(event==='complete')return;
  if(event==='connected'){selection=pathStore.snapshot();identity=f.store.db.prepare('SELECT id FROM sessions').get().id;}
  if(event==='connected'||event==='cancelled')assert.equal(f.approval.list().length,1);
  else {
   assert.equal(f.approval.list().length,2);replacement=f.approval.list().find(row=>row.id!==pending.requestId);
   if(event==='pending'){assert.equal(replacement.state,'pending');await f.decide(replacement.id,'deny');}
   else assert.equal(replacement.state,'denied');
  }
  assert.deepEqual(pathStore.snapshot(),selection);assert.deepEqual(readFileSync(config.tokenFile),credential);
  assert.deepEqual(f.store.db.prepare('SELECT id FROM sessions').all().map(row=>row.id),[identity]);
  writeFileSync(join(f.directory,event+'.ready'),'ready');
 }).catch(error=>{failure=error;child.kill();});});
 const [code]=await once(child,'exit');await work;assert.ifError(failure);assert.equal(code,0,stderr);
 assert.deepEqual(events,['connected','cancelled','pending','denied','reloaded','complete']);
 assert.equal(readFileSync(join(f.directory,'terminal-output.bin')).includes(credential),false);
});
