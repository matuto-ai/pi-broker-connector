// Real bundled CLI, installer, /reload and exact-conversation reopen. Synthetic
// HTTPS authority and local faux model only; never reads a user's installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createConfigPathStore } from '../src/config-path.mjs';
import { readConfig } from '../src/config.mjs';
import { PiBrokerSession } from '../src/session.mjs';
import { createTools } from '../vendor/broker/reference/tools.mjs';
const host=process.env.PI_TEST_INSTALL,source=process.env.PSST_TEST_SOURCE,old=process.env.PI_TEST_OLD_SOURCE,url=process.env.PI_TEST_URL_SOURCE;
if(!host||!source||!old||!url)throw Error('Set PI_TEST_INSTALL, PSST_TEST_SOURCE, PI_TEST_OLD_SOURCE and PI_TEST_URL_SOURCE to pinned fixtures');
assert.equal(JSON.parse(readFileSync(join(old,'package.json'))).version,'0.3.1');assert.equal(JSON.parse(readFileSync(join(url,'package.json'))).version,'0.4.0');
const {approvalTlsFixture}=await import(pathToFileURL(join(resolve(source),'test/approval-tls-fixture.mjs')));
const until=async predicate=>{const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('upgrade evidence timed out');};
function files(directory,name){const result=[];for(const item of readdirSync(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())result.push(...files(path,name));else if(item.name===name)result.push(path);}return result;}
function inboxRows(agent){return files(agent,'inbox.sqlite').flatMap(path=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT message_id,state,native_receipt FROM inbox').all();}finally{db.close();}});}
test('older native package upgrades/reloads in place, retaining installation, session and queued inbox',{timeout:120000},async t=>{
 const f=await approvalTlsFixture(t),agent=join(f.directory,'agent');
 const options={brokerUrl:f.brokerUrl,directory:join(agent,'psst/installation-credentials'),clientType:'pi'};
 const pending=await f.helper('beginApproval',options);await f.decide(pending.requestId,'approve');const approved=await f.helper('pollApproval',options);
 const config=readConfig({PI_CODING_AGENT_DIR:agent},approved.connectionFile),credential=readFileSync(config.tokenFile);
 const peer=new PiBrokerSession({config:{...config,stateDirectory:join(f.directory,'peer-state'),caFile:f.certFile,name:'upgrade fixture peer'},hostSessionId:'upgrade-peer',currentSessionId:()=> 'upgrade-peer'});await peer.start();t.after(()=>peer.close());
 const control={directory:f.directory,oldSource:resolve(old),urlSource:resolve(url),currentSource:process.cwd(),piCli:join(resolve(host),'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),fauxModule:join(resolve(host),'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'),connectionFile:approved.connectionFile,cert:f.certFile};
 const controlFile=join(f.directory,'upgrade-control.json');writeFileSync(controlFile,JSON.stringify(control));
 const child=spawn('python3',['scripts/upgrade-native-pty.py',controlFile],{stdio:['ignore','pipe','pipe']});
 let partial='',stderr='',work=Promise.resolve(),failure,recipient,sent,selection;const captures=[];
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
 child.stderr.on('data',data=>stderr+=data);
 child.stdout.on('data',buffer=>{partial+=buffer;const lines=partial.split('\n');partial=lines.pop();for(const line of lines)if(line)work=work.then(async()=>{
  const event=JSON.parse(line);if(event.event==='capture'){captures.push(event);return;}
  if(event.event==='complete')return;
  if(event.event==='old_connected'){
   selection=createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:agent}).snapshot();assert.equal(selection.connectionFile,approved.connectionFile);
   const clients=(await peer.client.listClients()).clients;recipient=clients.find(client=>client.client_id!==peer.inbox.identity.client_id);assert.ok(recipient);
   sent=await createTools({client:peer.client,inbox:peer.inbox}).broker_send({recipient_id:recipient.client_id,text:'retained across real native upgrades'});assert.ok(sent.message_id);
   await until(()=>inboxRows(agent).some(row=>row.message_id===sent.message_id&&row.state==='pending'));
  }else if(event.event==='url_reloaded'){
   assert.ok(inboxRows(agent).some(row=>row.message_id===sent.message_id&&row.state==='pending'));
  }else if(['current_reloaded','second_reloaded','restarted'].includes(event.event)){
   await until(()=>inboxRows(agent).some(row=>row.message_id===sent.message_id&&row.native_receipt?.startsWith('pi:')));
   const sessionFile=captures.at(-1).sessionFile;
   const records=readFileSync(sessionFile,'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(records.filter(row=>row.type==='custom_message'&&row.customType==='psst-agent-message'&&row.details?.message_id===sent.message_id).length,1,'upgrade/reopen must never replay the native message');
  }else throw Error('unexpected upgrade checkpoint');
  assert.deepEqual(createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:agent}).snapshot(),selection);
  assert.deepEqual(readFileSync(config.tokenFile),credential);assert.equal(f.approval.list().length,1);
  assert.ok((await peer.client.listClients()).clients.some(client=>client.client_id===recipient.client_id));
  writeFileSync(join(f.directory,event.event+'.ready'),'ready');
 }).catch(error=>{failure=error;child.kill();});});
 const [code]=await once(child,'exit');await work;assert.ifError(failure);assert.equal(code,0,stderr);
 assert.deepEqual(captures.map(row=>row.stage),['old','url_before_reload','url_after_reload','current_before_reload','current_after_reload','second_reload','restarted']);
 assert.equal(new Set(captures.map(row=>row.sessionId)).size,1);assert.ok(captures.every(row=>row.markers===1));
 assert.equal(readFileSync(join(f.directory,'terminal-output.bin')).includes(credential),false,'synthetic credential must not enter terminal output');
});
