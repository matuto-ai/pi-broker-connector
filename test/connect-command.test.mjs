import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTOR_VERSION } from '../src/runtime-support.mjs';
import { installExtension } from '../src/extension.mjs';
import { createConfigPathStore } from '../src/config-path.mjs';
import { PiBrokerSession } from '../src/session.mjs';
import { ApprovalWatch } from '../src/approval-watch.mjs';
function approvedSetup(file,url='https://broker.example',onCall=()=>{}) {
 return async (_ctx,{beforeBegin})=>{onCall();await beforeBegin({brokerUrl:url});return {state:'approved',requestId:'request-fixture',connectionFile:file,brokerUrl:url};};
}
function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'pi-connect-')); t.after(()=>rmSync(home,{recursive:true,force:true}));
 const file=join(home,'connection.json');
 writeFileSync(file,JSON.stringify({format:'broker-client-bundle-v1',protocol_version:'1',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,broker_url:'https://broker.example',token_file:'token',allowed_client_types:['pi']}),{mode:0o600});
 const pathStore=createConfigPathStore(home),env={PSST_STATE_DIR:join(home,'state')};
 let sessionId='native-A',active=0,peak=0; const instances=[],notices=[];
 const ctx={hasUI:true,sessionManager:{getSessionId:()=>sessionId},ui:{setStatus(){},notify:text=>notices.push(text)}};
 const createSession=options=>{const session=new PiBrokerSession(options),close=session.close.bind(session);let started=false;
 session.start=async()=>{started=true;active++;peak=Math.max(peak,active);};session.close=async()=>{if(started){active--;started=false;}await close();};instances.push(session);return session;};
 const load=(overrides={})=>{const events={},commands={},tools={};const Type={Object:()=>({}),String:()=>({}),Optional:()=>({}),Boolean:()=>({}),Integer:()=>({})};
 installExtension({on:(n,f)=>events[n]=f,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t},Type,{pathStore,env,createSession,...overrides});return {events,commands,tools};};
 return {home,file,pathStore,env,ctx,load,instances,notices,setSession:id=>sessionId=id,get active(){return active;},get peak(){return peak;}};
}
test('connect activates current session without env; TXT survives reload; reconnect has one owner',async t=>{
 const f=fixture(t);let host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);const first=f.instances.at(-1).inbox.identity.client_id;
 assert.equal(f.pathStore.read(),f.file);assert.equal(statSync(join(f.home,'.pi/agent/psst/selection.sqlite')).mode&0o777,0o600);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.instances.at(-1).inbox.identity.client_id,first);assert.equal(f.peak,1);
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.instances.at(-1).inbox.identity.client_id,first);assert.equal(f.active,1);
 f.setSession('native-B');await host.events.session_start({},f.ctx);assert.notEqual(f.instances.at(-1).inbox.identity.client_id,first);await host.events.session_shutdown();assert.equal(f.active,0);
});
test('invalid command preserves working session; concurrent connect/shutdown cannot revive it',async t=>{
 const f=fixture(t),host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.commands['psst-connect'].handler('relative.json',f.ctx);assert.equal(f.active,1);assert.equal(f.pathStore.read(),f.file);
 await host.commands['psst-connect'].handler('/missing/connection.json',f.ctx);assert.equal(f.active,1);
 await Promise.all([host.commands['psst-connect'].handler(f.file,f.ctx),host.events.session_shutdown()]);assert.equal(f.active,0);assert.equal(f.peak,1);assert.ok(f.notices.every(text=>!text.includes(f.file)));
});
test('TXT rejects multiline/relative/public/symlink; explicit env keeps precedence',async t=>{
 const f=fixture(t);assert.equal(f.pathStore.read(),null);const pointer=join(f.home,'.pi/agent/psst/pi-config-path');mkdirSync(join(f.home,'.pi/agent/psst'),{recursive:true,mode:0o700});writeFileSync(pointer,f.file+'\n',{mode:0o600});
 for(const value of ['relative.json\n',f.file+'\n/other\n']){writeFileSync(pointer,value);assert.throws(()=>f.pathStore.read());}
 writeFileSync(pointer,f.file+'\n');chmodSync(pointer,0o644);assert.throws(()=>f.pathStore.read());rmSync(pointer);symlinkSync(f.file,pointer);assert.throws(()=>f.pathStore.read());
 f.env.PSST_CONFIG_FILE=f.file;const host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('diagnostic disconnect survives reload until explicit reconnect; manual mode survives reconnect',async t=>{
 const f=fixture(t);f.env.PSST_DIAGNOSTIC_MANUAL='1';let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.commands['psst-mode'].handler('manual',f.ctx);
 await host.commands['psst-disconnect'].handler('',f.ctx);assert.equal(f.active,0);
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);
 const result=await host.tools.broker_identity.execute('id',{},undefined,undefined,f.ctx);assert.equal(result.details.local_mode,'cooperative_pull');
 await host.events.session_shutdown();
});

test('pairing completion after shutdown cannot reconnect or replace remembered configuration',async t=>{
 const f=fixture(t);let finish;const host=f.load({connectionResolver:()=>new Promise(resolve=>finish=resolve)});
 await host.events.session_start({},f.ctx);const pending=host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.events.session_shutdown();finish(f.file);await pending;assert.equal(f.active,0);assert.equal(f.pathStore.read(),null);
});

test('native setup is explicit once; two fresh sessions auto-connect without setup or credential rotation',async t=>{
 const f=fixture(t);let setups=0;const overrides={setupUI:approvedSetup(f.file,'https://broker.example',()=>setups++)};
 let host=f.load(overrides);await host.commands['psst-setup'].handler('',f.ctx);assert.equal(setups,1);await host.events.session_shutdown();
 const ids=new Set();for(let i=0;i<2;i++){f.setSession(`fresh-${i}`);host=f.load(overrides);await host.events.session_start({},f.ctx);ids.add(f.instances.at(-1).inbox.identity.client_id);await host.events.session_shutdown();}
 assert.equal(ids.size,2);assert.equal(setups,1);assert.equal(f.pathStore.read(),f.file);
});

test('failed native setup attachment leaves previous installation selection untouched',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 const replacement=join(f.home,'replacement.json');writeFileSync(replacement,readFileSync(f.file),{mode:0o600});
 const host=f.load({setupUI:approvedSetup(replacement),createSession:()=>{throw Error('synthetic attach failure');}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.deepEqual(f.pathStore.snapshot(),before);
});

test('native setup CAS does not overwrite selection changed during registration',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');
 const replacement=join(f.home,'replacement.json');writeFileSync(replacement,readFileSync(f.file),{mode:0o600});
 const host=f.load({setupUI:approvedSetup(replacement),createSession:options=>{const s=new PiBrokerSession(options);s.start=async()=>{f.pathStore.write(f.file,'https://broker.example');};return s;}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.read(),f.file);assert.ok(f.notices.some(n=>n.includes('selection was not overwritten')));await host.events.session_shutdown();
});

test('explicit native setup may replace saved broker A with approved B after success only',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');
 const replacement=join(f.home,'broker-b.json');const bundle=JSON.parse(readFileSync(f.file));bundle.broker_url='https://broker-b.example';writeFileSync(replacement,JSON.stringify(bundle),{mode:0o600});
 const host=f.load({setupUI:approvedSetup(replacement,'https://broker-b.example')});
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.snapshot().brokerUrl,'https://broker-b.example');assert.equal(f.pathStore.read(),replacement);await host.events.session_shutdown();
});

test('failed legacy explicit connect and unsafe snapshot do not replace saved selection',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 const host=f.load({createSession:()=>{throw Error('fixture failure');}});await host.commands['psst-connect'].handler(f.file,f.ctx);assert.deepEqual(f.pathStore.snapshot(),before);
 const unsafe=f.load({pathStore:{snapshot(){throw Error('raw local path must not leak');},read(){return null;}}});
 await unsafe.commands['psst-setup'].handler('',f.ctx);assert.equal(f.notices.some(s=>s.includes('raw local path')),false);
});

test('pending survives reopen with GET-only approval checks and no second enrollment',async t=>{
 const f=fixture(t);let begins=0,reads=0,polls=0;
 const client={readApprovalState:async()=>{reads++;return{state:'approved',requestId:'saved-request',connectionFile:f.file};},pollApproval:async()=>{polls++;throw Error('unneeded');}};
 const setupUI=async(_ctx,{beforeBegin})=>{begins++;await beforeBegin({brokerUrl:'https://broker.example'});return{state:'pending',requestId:'saved-request',brokerUrl:'https://broker.example'};};
 let host=f.load({setupUI,approvalClient:client});await host.commands['psst-setup'].handler('',f.ctx);
 assert.equal(f.active,0);assert.equal(f.pathStore.readPending().requestId,'saved-request');
 await host.events.session_shutdown();host=f.load({setupUI,approvalClient:client});await host.events.session_start({},f.ctx);
 assert.equal(f.active,1);assert.equal(f.pathStore.read(),f.file);assert.equal(f.pathStore.readPending().requestId,'saved-request');assert.equal(begins,1);assert.equal(reads,1);assert.equal(polls,0);await host.events.session_shutdown();
});

test('disconnect cancels pending persistently and late result cannot connect',async t=>{
 const f=fixture(t);let release;
 const setupUI=async(_ctx,{beforeBegin})=>{await beforeBegin({brokerUrl:'https://broker.example'});return await new Promise(r=>release=r);};
 let host=f.load({setupUI});const task=host.commands['psst-setup'].handler('',f.ctx);await new Promise(r=>setImmediate(r));
 await host.commands['psst-disconnect'].handler('',f.ctx);release({state:'approved',requestId:'late',connectionFile:f.file,brokerUrl:'https://broker.example'});await task;
 assert.equal(f.active,0);assert.notEqual(f.pathStore.readPending(),null);assert.equal(f.pathStore.isDisconnected('native-A'),true);assert.equal(f.pathStore.read(),null);
 host=f.load({approvalClient:{readApprovalState:()=>{throw Error('must not poll canceled');}}});await host.events.session_start({},f.ctx);assert.equal(f.active,0);await host.events.session_shutdown();
});

test('uncertain begin recovers exact durable request after reopen without POST; absent state never creates',async t=>{
 const f=fixture(t);let begins=0;
 const setupUI=async(_ctx,{beforeBegin})=>{begins++;await beforeBegin({brokerUrl:'https://broker.example'});throw Error('lost response');};
 let host=f.load({setupUI});await host.commands['psst-setup'].handler('',f.ctx);assert.equal(f.pathStore.readPending().requestId,null);await host.events.session_shutdown();
 host=f.load({setupUI,approvalClient:{readApprovalState:async()=>null}});await host.events.session_start({},f.ctx);assert.equal(f.active,0);assert.equal(begins,1);await host.events.session_shutdown();
 host=f.load({setupUI,approvalClient:{readApprovalState:async()=>({state:'approved',requestId:'durable',connectionFile:f.file})}});await host.events.session_start({},f.ctx);assert.equal(f.active,1);assert.equal(begins,1);await host.events.session_shutdown();
});

test('denial and wrong-origin approval preserve working selection and unread mailbox',async t=>{
 const f=fixture(t);let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 const before=f.pathStore.snapshot(),identity=f.instances.at(-1).inbox.identity.client_id;await host.events.session_shutdown();
 for(const terminal of ['denied','expired','revoked']){
  const setupUI=async(_ctx,{beforeBegin})=>{await beforeBegin({brokerUrl:'https://broker.example',replaceRequestId:f.pathStore.readPending()?.requestId});return{state:terminal,requestId:`request-${terminal}`,brokerUrl:'https://broker.example'};};
  host=f.load({setupUI});await host.events.session_start({},f.ctx);await host.commands['psst-setup'].handler('',f.ctx);
  assert.deepEqual(f.pathStore.snapshot(),before);assert.equal(f.active,1);assert.equal(f.instances.at(-1).inbox.identity.client_id,identity);assert.notEqual(f.pathStore.readPending(),null);await host.events.session_shutdown();
 }
 host=f.load({setupUI:approvedSetup(f.file,'https://wrong.example')});await host.events.session_start({},f.ctx);await host.commands['psst-setup'].handler('',f.ctx);
 assert.deepEqual(f.pathStore.snapshot(),before);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('failed approved replacement restores prior working connection without changing selection',async t=>{
 const f=fixture(t),replacement=join(f.home,'replacement.json');const bundle=JSON.parse(readFileSync(f.file));bundle.broker_url='https://new.example';writeFileSync(replacement,JSON.stringify(bundle),{mode:0o600});
 const initial=f.load();await initial.commands['psst-connect'].handler(f.file,f.ctx);await initial.events.session_shutdown();
 const prior=f.pathStore.snapshot();let active=0;
 const host=f.load({setupUI:approvedSetup(replacement,'https://new.example'),createSession:options=>{
  if(new URL(options.config.url).origin==='https://new.example')throw Error('synthetic attach failure');
  const instance=new PiBrokerSession(options),close=instance.close.bind(instance);instance.start=async()=>active++;instance.close=async()=>{active--;await close();};return instance;
 }});
 await host.events.session_start({},f.ctx);assert.equal(active,1);await host.commands['psst-setup'].handler('',f.ctx);assert.equal(active,1);assert.deepEqual(f.pathStore.snapshot(),prior);assert.notEqual(f.pathStore.readPending(),null);await host.events.session_shutdown();
});

test('startup origin override mismatch never sends pending credentials or overrides explicit bundle',async t=>{
 const f=fixture(t);let reads=0;const pointer={intentId:'fixture-intent',requestId:'fixture-request',brokerUrl:'https://broker.example',selectionRevision:'empty'};
 f.pathStore.writePending(pointer);const client={readApprovalState:async()=>{reads++;throw Error('must not inspect pending credential');}};
 f.env.PSST_BROKER_URL='https://other.example';let host=f.load({approvalClient:client});await host.events.session_start({},f.ctx);assert.equal(reads,0);assert.equal(f.active,0);await host.events.session_shutdown();
 delete f.env.PSST_BROKER_URL;f.env.PSST_CONFIG_FILE=f.file;host=f.load({approvalClient:client});await host.events.session_start({},f.ctx);assert.equal(reads,0);assert.equal(f.active,1);await host.events.session_shutdown();
});

test('corrupt pending state cannot prevent explicit transport disconnect',async t=>{
 const f=fixture(t);let corrupt=false;const store={...f.pathStore,readPending(){if(corrupt)throw Error('unsafe fixture');return f.pathStore.readPending();}};
 const host=f.load({pathStore:store});await host.commands['psst-connect'].handler(f.file,f.ctx);assert.equal(f.active,1);
 corrupt=true;await host.commands['psst-disconnect'].handler('',f.ctx);assert.equal(f.active,0);assert.ok(!f.notices.some(n=>n.includes('unsafe fixture')));await host.events.session_shutdown();
});

for(const disconnectOne of [false,true])test(`two waiting sessions recognize same approval winner; local disconnect=${disconnectOne}`,async t=>{
 const watches=[];t.mock.method(ApprovalWatch.prototype,'start',function(){watches.push(this);});
 const f=fixture(t);let approved=false,begins=0,reads=0;
 const client={readApprovalState:async()=>{reads++;return{state:approved?'approved':'pending',requestId:'shared-request',connectionFile:f.file};},pollApproval:async()=>({state:approved?'approved':'pending',requestId:'shared-request',connectionFile:f.file})};
 const setupUI=async(_ctx,{beforeBegin})=>{begins++;await beforeBegin({brokerUrl:'https://broker.example'});return{state:'pending',requestId:'shared-request',brokerUrl:'https://broker.example'};};
 const hosts=[],contexts=[];
 for(let i=0;i<2;i++){
  const ctx={...f.ctx,sessionManager:{getSessionId:()=>`concurrent-native-${i}`}};contexts.push(ctx);
  const host=f.load({setupUI,approvalClient:client});hosts.push(host);
  if(i===0)await host.commands['psst-setup'].handler('',ctx);else await host.events.session_start({},ctx);
 }
 assert.equal(f.active,0);assert.equal(begins,1);const intent=f.pathStore.readPending();
 if(disconnectOne){
  await hosts[0].commands['psst-disconnect'].handler('',contexts[0]);await hosts[0].events.session_shutdown();
  assert.deepEqual(f.pathStore.readPending(),intent);const beforeReads=reads;
  hosts[0]=f.load({setupUI,approvalClient:client});await hosts[0].events.session_start({},contexts[0]);assert.equal(reads,beforeReads);
 }
 approved=true;const expected=disconnectOne?1:2;
 for(const watch of [...watches])await watch.tick();
 assert.equal(f.active,expected);assert.equal(begins,1);assert.equal(new Set(f.instances.map(s=>s.inbox.identity.client_id)).size,expected);
 assert.equal(f.pathStore.snapshot().approvalRequestId,'shared-request');assert.equal(f.pathStore.readPending().intentId,intent.intentId);
 if(disconnectOne){await hosts[0].events.session_start({},contexts[0]);assert.equal(f.active,1);assert.equal(f.pathStore.isDisconnected('concurrent-native-0'),true);}
 for(const host of hosts)await host.events.session_shutdown();assert.equal(f.active,0);
});

test('only still-active explicit setup retries uncertain initial POST; shutdown startup never begins',async t=>{
 const watches=[];t.mock.method(ApprovalWatch.prototype,'start',function(){watches.push(this);});
 const f=fixture(t);let retries=0;
 const setupUI=async(_ctx,{beforeBegin})=>{await beforeBegin({brokerUrl:'https://broker.example',directory:f.home,clientType:'pi'});throw Object.assign(Error('uncertain'),{retryable:true,retryAfterMs:2000});};
 const client={beginApproval:async()=>{retries++;return{state:'approved',requestId:'same-durable-request',connectionFile:f.file};},readApprovalState:async()=>null};
 let host=f.load({setupUI,approvalClient:client});await host.commands['psst-setup'].handler('',f.ctx);
 await watches[0].tick();assert.equal(f.active,1);assert.equal(retries,1);await host.events.session_shutdown();
 const next=fixture(t);host=next.load({setupUI,approvalClient:client});await host.commands['psst-setup'].handler('',next.ctx);await host.events.session_shutdown();
 host=next.load({setupUI,approvalClient:client});await host.events.session_start({},next.ctx);for(const watch of [...watches])await watch.tick();assert.equal(retries,1);assert.equal(next.active,0);await host.events.session_shutdown();
});

test('new local setup is gated while approved attachment is awaiting native registration',async t=>{
 const f=fixture(t);let release,started,uiCalls=0;const waiting=new Promise(r=>started=r);
 const host=f.load({setupUI:approvedSetup(f.file,'https://broker.example',()=>uiCalls++),createSession:options=>{const adapter=new PiBrokerSession(options);adapter.start=()=>{started();return new Promise(r=>release=r);};return adapter;}});
 const first=host.commands['psst-setup'].handler('',f.ctx);await waiting;const pointer=f.pathStore.readPending();
 await host.commands['psst-setup'].handler('',f.ctx);assert.equal(uiCalls,1);assert.deepEqual(f.pathStore.readPending(),pointer);assert.equal(f.pathStore.read(),null);
 release();await first;assert.equal(f.pathStore.read(),f.file);assert.equal(f.pathStore.snapshot().approvalIntentId,pointer.intentId);await host.events.session_shutdown();
});

test('newer cross-process intent during old registration prevents stale promotion and preserves new pointer',async t=>{
 const f=fixture(t);let release,started;const waiting=new Promise(r=>started=r);
 const host=f.load({setupUI:approvedSetup(f.file),createSession:options=>{const adapter=new PiBrokerSession(options);adapter.start=()=>{started();return new Promise(r=>release=r);};return adapter;}});
 const task=host.commands['psst-setup'].handler('',f.ctx);await waiting;const old=f.pathStore.readPending();
 const next={...old,intentId:'next-explicit-intent',requestId:'next-explicit-request'};assert.equal(f.pathStore.writePending(next,old.intentId),true);
 release();await task;assert.equal(f.pathStore.read(),null);assert.deepEqual(f.pathStore.readPending(),next);assert.ok(f.notices.some(n=>n.includes('superseded')));await host.events.session_shutdown();
});

test('bare connect without a saved connection guides setup/status without creating state',async t=>{
 const f=fixture(t);let reads=0;const host=f.load({pathStore:{read:()=>null,snapshot(){reads++;throw Error('must not inspect absent selection');}}});
 await host.commands['psst-connect'].handler('',f.ctx);assert.equal(reads,0);assert.equal(f.active,0);
 assert.match(f.notices.at(-1),/psst-setup.*psst-status/);assert.equal(f.notices.at(-1).includes('invalid_configuration'),false);
});
test('setup reports sanitized failing phase and status retains last diagnostic',async t=>{
 const f=fixture(t),secret='fixture-secret-private';
 const host=f.load({setupUI:async(_ctx,{onPhase})=>{onPhase('url_validation');throw Object.assign(Error(secret),{code:'broker_origin_mismatch'});}});
 await host.commands['psst-setup'].handler('',f.ctx);
 assert.match(f.notices.at(-1),/broker_origin_mismatch; phase=url_validation; request=not_started/);
 await host.commands['psst-status'].handler('',f.ctx);
 assert.ok(f.notices.filter(n=>n.includes('phase=url_validation')).length>=2);
 assert.ok(f.notices.some(n=>n.includes(`connector ${CONNECTOR_VERSION}`)));assert.ok(f.notices.every(n=>!n.includes(secret)));
 assert.equal(f.pathStore.readPending(),null);
});
test('failed request after intent save reports unknown outcome, preserving exact pending intent',async t=>{
 const f=fixture(t);const host=f.load({setupUI:async(_ctx,{beforeBegin,onPhase})=>{await beforeBegin({brokerUrl:'https://broker.example'});onPhase('enrollment_request');throw Object.assign(Error('raw body must not leak'),{code:'invalid_response'});}});
 await host.commands['psst-setup'].handler('',f.ctx);assert.ok(f.pathStore.readPending().intentId);
 assert.match(f.notices.at(-1),/invalid_response; phase=enrollment_request; request=outcome_unknown/);
 assert.equal(f.pathStore.read(),null);assert.ok(f.notices.every(n=>!n.includes('raw body')));
});
test('invalid storage does not prevent registration of read-only doctor and diagnostic commands',async t=>{
 const f=fixture(t),root=join(f.home,'unsafe-agent','psst');mkdirSync(root,{recursive:true,mode:0o700});
 writeFileSync(join(root,'selection.sqlite'),'private-not-sqlite',{mode:0o600});
 const env={PI_CODING_AGENT_DIR:join(f.home,'unsafe-agent')};const host=f.load({env,pathStore:null});
 await host.commands['psst-doctor'].handler('',f.ctx);assert.match(f.notices.at(-1),/selection_file=ok/);
 await host.commands['psst-setup'].handler('',f.ctx);assert.match(f.notices.at(-1),/phase=selection_read; request=not_started/);
 assert.equal(readFileSync(join(root,'selection.sqlite'),'utf8'),'private-not-sqlite');
});


test('production tools are automatic-only; legacy manual selection cannot silently disable native delivery',async t=>{
 const f=fixture(t);f.env.PSST_DIAGNOSTIC_MANUAL='1';let host=f.load();
 assert.ok(host.commands['psst-mode']);assert.ok(host.tools.broker_receive);assert.ok(host.tools.broker_acknowledge);
 await host.commands['psst-connect'].handler(f.file,f.ctx);await host.commands['psst-mode'].handler('manual',f.ctx);
 await host.events.session_shutdown();delete f.env.PSST_DIAGNOSTIC_MANUAL;host=f.load();
 assert.equal(host.commands['psst-mode'],undefined);assert.equal(host.tools.broker_receive,undefined);assert.equal(host.tools.broker_acknowledge,undefined);
 await host.events.session_start({},f.ctx);
 const identity=await host.tools.broker_identity.execute('id',{},undefined,undefined,f.ctx);assert.equal(identity.details.local_mode,'native_auto');
 assert.equal(f.instances.at(-1).inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='mode'").get().value,'manual','migration changes behavior, not stored inbox state');
 await host.commands['psst-disconnect'].handler('',f.ctx);await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(f.active,0,'disconnect still hard-stops on reload');
 await host.events.session_shutdown();
});

test('only exact explicit diagnostic flag exposes cooperative tools; production never creates their receipt table',async t=>{
 for(const value of [undefined,'','0','true']){
  const f=fixture(t);if(value!==undefined)f.env.PSST_DIAGNOSTIC_MANUAL=value;const host=f.load();
  assert.equal(host.tools.broker_receive,undefined);assert.equal(host.tools.broker_acknowledge,undefined);assert.equal(host.commands['psst-mode'],undefined);
  await host.commands['psst-connect'].handler(f.file,f.ctx);
  assert.equal(f.instances.at(-1).inbox.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cooperative_receipts'").get().n,0);
  await host.events.session_shutdown();
 }
});


test('bare connect resumes saved credential/mailbox after explicit disconnect without enrollment or selection replacement',async t=>{
 const f=fixture(t);let approvalCalls=0;const forbidden=()=>{approvalCalls++;throw Error('no enrollment permitted');};
 const overrides={approvalClient:{readApprovalState:forbidden,beginApproval:forbidden,pollApproval:forbidden},setupUI:forbidden,connectionResolver:async file=>file};
 let host=f.load(overrides);await host.commands['psst-connect'].handler(f.file,f.ctx);const identity=f.instances.at(-1).inbox.identity.client_id,saved=f.pathStore.snapshot();
 await host.commands['psst-disconnect'].handler('',f.ctx);await host.events.session_shutdown();host=f.load(overrides);await host.events.session_start({},f.ctx);assert.equal(f.active,0);
 await host.commands['psst-connect'].handler('',f.ctx);assert.equal(f.active,1);assert.equal(f.instances.at(-1).inbox.identity.client_id,identity);assert.deepEqual(f.pathStore.snapshot(),saved);assert.equal(approvalCalls,0);
 const instances=f.instances.length;await host.commands['psst-connect'].handler('',f.ctx);assert.equal(f.instances.length,instances,'already connected is a no-op');assert.equal(approvalCalls,0);
 await host.events.session_shutdown();
});

test('bare connect invalid or expired saved selection preserves selection, stop flag and pending intent',async t=>{
 for(const code of ['invalid_configuration','credential_expired']){
  const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');f.pathStore.setDisconnected('native-A',true);const saved=f.pathStore.snapshot();
  let enrollments=0;const host=f.load({configReader:()=>{throw Object.assign(Error('private raw path must not appear'),{code});},approvalClient:{beginApproval(){enrollments++;}}});
  await host.commands['psst-connect'].handler('',f.ctx);assert.deepEqual(f.pathStore.snapshot(),saved);assert.equal(f.pathStore.isDisconnected('native-A'),true);assert.equal(f.active,0);assert.equal(enrollments,0);assert.ok(f.notices.some(n=>n.includes('psst-doctor')));assert.ok(f.notices.every(n=>!n.includes('private raw path')));
 }
});

test('shutdown during bare reconnect cannot attach late or replace the saved selection',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const saved=f.pathStore.snapshot();let release,entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const host=f.load({createSession:options=>{const session=new PiBrokerSession(options);session.start=async()=>{entered();await gate;};return session;},setupUI:()=>{throw Error('must not setup');}});
 const connecting=host.commands['psst-connect'].handler('',f.ctx);await started;const stopping=host.events.session_shutdown();release();await Promise.all([connecting,stopping]);
 assert.deepEqual(f.pathStore.snapshot(),saved);assert.ok(f.notices.every(n=>!n.includes('Psst reconnected')));
 const result=await host.tools.broker_identity.execute('identity',{},undefined,undefined,f.ctx);assert.equal(result.details.error.code,'session_mismatch');
});


test('bare connect retries a paused transport instead of claiming an already healthy connection',async t=>{
 const f=fixture(t);let enrollments=0;const host=f.load({setupUI:()=>{enrollments++;throw Error('no enrollment');}});
 await host.commands['psst-connect'].handler(f.file,f.ctx);const first=f.instances.at(-1),id=first.inbox.identity.client_id,saved=f.pathStore.snapshot();
 first.runtime.handleTransportError({code:'unauthenticated'});assert.equal(first.runtime.paused,true);assert.equal(first.isAlive(),true);
 const before=f.instances.length;await host.commands['psst-connect'].handler('',f.ctx);
 assert.equal(f.instances.length,before+1);assert.equal(f.instances.at(-1).inbox.identity.client_id,id);assert.equal(f.instances.at(-1).deliveryAllowed(),true);assert.deepEqual(f.pathStore.snapshot(),saved);assert.equal(enrollments,0);assert.match(f.notices.at(-1),/reconnected/);
 await host.events.session_shutdown();
});


test('abort holds the exact conversation across reload; explicit connect and human input resume it',async t=>{
 const f=fixture(t);let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 const paused=()=>f.instances.at(-1).inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='human_paused'").get()?.value;
 await host.events.agent_settled({aborted:true},f.ctx);assert.equal(paused(),'true');
 await host.events.input({source:'extension',text:'yes'},f.ctx);assert.equal(paused(),'true');
 await host.events.session_shutdown();host=f.load();await host.events.session_start({},f.ctx);assert.equal(paused(),'true');
 await host.commands['psst-status'].handler('',f.ctx);assert.ok(f.notices.some(text=>text.includes('paused after an aborted turn')));
 await host.commands['psst-connect'].handler('',f.ctx);assert.equal(paused(),'false');
 await host.events.agent_settled({aborted:true},f.ctx);await host.events.input({source:'interactive',text:'continue'},f.ctx);assert.equal(paused(),'false');
 await host.events.agent_settled({aborted:true},f.ctx);f.setSession('native-B');await host.events.session_start({},f.ctx);assert.notEqual(paused(),'true');
 f.setSession('native-A');await host.events.session_start({},f.ctx);assert.equal(paused(),'true');
 await host.events.session_shutdown();
});


test('background approval and failed replacement rollback preserve human abort hold',async t=>{
 const f=fixture(t);let host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 await host.events.agent_settled({aborted:true},f.ctx);await host.events.session_shutdown();
 const prior=f.pathStore.snapshot(),replacement=join(f.home,'replacement-paused.json');
 const bundle=JSON.parse(readFileSync(f.file));bundle.broker_url='https://replacement.example';writeFileSync(replacement,JSON.stringify(bundle),{mode:0o600});
 f.pathStore.writePending({intentId:'paused-replacement',brokerUrl:'https://replacement.example',requestId:'paused-request',selectionRevision:prior.revision});
 host=f.load({approvalClient:{readApprovalState:async()=>({state:'approved',requestId:'paused-request',connectionFile:replacement})}});
 await host.events.session_start({},f.ctx);
 const paused=()=>f.instances.at(-1).inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='human_paused'").get()?.value;
 assert.equal(paused(),'true','background approval cannot resume an aborted conversation, including a replacement mailbox');
 await host.events.session_shutdown();
 host=f.load({setupUI:approvedSetup(f.file,'https://broker.example'),createSession:options=>{
  if(new URL(options.config.url).origin==='https://broker.example')throw Error('replacement fails');
  const instance=new PiBrokerSession(options);instance.start=async()=>{};f.instances.push(instance);return instance;
 }});
 await host.events.session_start({},f.ctx);assert.equal(paused(),'true');await host.commands['psst-setup'].handler('',f.ctx);
 assert.equal(paused(),'true','rollback is transport recovery, not a human resume');
 assert.ok(f.notices.some(text=>text.includes('approved connection could not attach')));
 await host.events.session_shutdown();
});


test('a late explicit reconnect cannot clear an abort received during registration',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');let release,entered,instance;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const host=f.load({createSession:options=>{instance=new PiBrokerSession(options);instance.start=async()=>{entered();await gate;};return instance;}});
 const connecting=host.commands['psst-connect'].handler('',f.ctx);await started;
 await host.events.agent_settled({aborted:true},f.ctx);release();await connecting;
 assert.equal(instance.inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='human_paused'").get()?.value,'true');
 await host.events.session_shutdown();
});

test('abort while resolving an explicit connection file wins over earlier resume intent',async t=>{
 const f=fixture(t);let release,entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const host=f.load({connectionResolver:async file=>{entered();await gate;return file;}});
 const connecting=host.commands['psst-connect'].handler(f.file,f.ctx);await started;
 await host.events.agent_settled({aborted:true},f.ctx);release();await connecting;
 assert.equal(f.instances.at(-1).inbox.db.prepare("SELECT value FROM pi_delivery_settings WHERE key='human_paused'").get()?.value,'true');
 await host.events.session_shutdown();
});

test('ownership diagnostic names the local conversation without guessing an owner and normal release resumes its inbox',async t=>{
 const f=fixture(t);f.ctx.sessionManager.getSessionName=()=> 'Review\n\x1b[31m\u202eyes';
 const first=f.load();await first.commands['psst-connect'].handler(f.file,f.ctx);const id=f.instances.at(-1).inbox.identity.client_id;
 const second=f.load();t.after(()=>second.events.session_shutdown());t.after(()=>first.events.session_shutdown());
 await second.events.session_start({},f.ctx);
 const diagnostic=f.notices.at(-1);assert.match(diagnostic,/owner_conflict.*phase=/);
 assert.match(diagnostic,/Review/);assert.match(diagnostic,/\[[a-f0-9]{8}\]/);assert.match(diagnostic,/another active process is not confirmed/);assert.match(diagnostic,/only after confirming/);
 assert.doesNotMatch(diagnostic,/[\x00-\x1f\x7f-\x9f\u202e]/);assert.equal(diagnostic.includes(f.home),false);assert.equal(f.active,1);
 f.notices.length=0;await second.commands['psst-status'].handler('',f.ctx);assert.ok(f.notices.some(n=>n.includes(diagnostic)));
 await first.events.session_shutdown();await second.events.session_start({},f.ctx);assert.equal(f.active,1);assert.equal(f.instances.at(-1).inbox.identity.client_id,id);assert.equal(f.pathStore.read(),f.file);
});

// A real Pi TUI coalesces successive notify calls. This command must be atomic.
test('status and doctor each emit one complete visible runtime report',async t=>{
 const f=fixture(t),host=f.load();
 f.notices.length=0;await host.commands['psst-status'].handler('',f.ctx);
 assert.equal(f.notices.length,1);assert.match(f.notices[0],/Psst connector .*Node .*Psst /s);
 f.notices.length=0;await host.commands['psst-doctor'].handler('',f.ctx);
 assert.equal(f.notices.length,1);assert.match(f.notices[0],/Psst connector .*selection_directory/s);
});

test('discovery forwards caller filters and returns client results without rewriting presence',async t=>{
 const f=fixture(t),host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 t.after(()=>host.events.session_shutdown());
 const session=f.instances.at(-1),requests=[];
 const response={clients:[{client_id:'offline-peer',connected:false}],next_cursor:'next-page'};
 session.client.listClients=async (filters,options)=>{requests.push({...filters,...options});return response;};
 const filters={connected:false,client_type:'pi',name:'Review',project:'project',limit:1,cursor:'previous-page'};
 const result=await host.tools.broker_list_clients.execute('discovery',filters,undefined,undefined,f.ctx);
 assert.equal(result.isError,undefined);assert.deepEqual(result.details,response);
 assert.deepEqual(requests.map(({signal,...options})=>options),[filters]);
 assert.equal(requests[0].signal.aborted,false);
});

for(const command of ['psst-setup','psst-reauthorize'])test(`${command}: selected cached approval after server revocation requires explicit replacement and retains durable candidate`,async t=>{
 const helper=await import('../vendor/broker/reference/approval.mjs');
 const f=fixture(t);f.env.PI_CODING_AGENT_DIR=join(f.home,'native-agent');
 const watches=[];t.mock.method(ApprovalWatch.prototype,'start',function(){watches.push(this);});
 let approved=true,uncertain=false,confirms=0,posts=0,oldFile;
 const ids=new Set(),keys=new Set();
 const transport=async(_origin,method,_path,token,body)=>{
  if(method==='POST'){posts++;ids.add(body.request_id);keys.add(token);if(uncertain){uncertain=false;throw Object.assign(Error('lost response'),{code:'approval_transport_error',retryable:true,effect:'unknown'});}}
  const id=body?.request_id||[...ids].at(-1);
  return {status:201,body:{request_id:id,state:approved?'approved':'pending',request_expires_at:'2099-01-01T00:00:00Z',...(approved?{credential:{protocol_version:'1',client_type:'pi',credential_id:'enrolled-'+id,adapter_id:'installation-'+id,scopes:['messages'],expires_at:'2099-01-01T00:00:00Z'}}:{})}};
 };
 const client={readApprovalState:helper.readApprovalState,beginApproval:o=>helper.beginApproval(o,{transport}),pollApproval:o=>helper.pollApproval(o,{transport,pollIntervalMs:0})};
 f.ctx.ui.input=async()=> 'https://broker.example';f.ctx.ui.confirm=async()=>{confirms++;return true;};
 const args=command==='psst-reauthorize'?'https://broker.example':'';
 let host=f.load({approvalClient:client});await host.commands[command].handler(args,f.ctx);
 const selected=f.pathStore.snapshot(),intent=f.pathStore.readPending();oldFile=selected.connectionFile;
 const original=readFileSync(oldFile),oldToken=readFileSync(join(oldFile,'..','token'));
 assert.equal(ids.size,1);assert.equal(confirms,0);assert.equal(selected.approvalIntentId,intent.intentId);
 await host.events.session_shutdown();
 let rejects=0;
 const rejected=()=>{rejects++;throw Object.assign(Error('private server details'),{code:'unauthenticated'});};
 host=f.load({approvalClient:client,createSession:rejected});
 await host.events.session_start({},f.ctx);assert.equal(rejects,1,'no cached approval reattachment loop');
 await host.commands['psst-connect'].handler('',f.ctx);assert.equal(posts,1,'restart and reconnect never enroll');
 await host.commands['psst-status'].handler('',f.ctx);assert.match(f.notices.at(-1),/cached_approved.*unauthenticated/s);
 assert.ok(!f.notices.at(-1).includes('private server details'));
 approved=false;uncertain=true;
 await host.commands[command].handler(args,f.ctx);
 assert.equal(confirms,command==='psst-reauthorize'?0:1);assert.equal(ids.size,2);assert.equal(keys.size,2);
 const candidate=f.pathStore.readPending();
 for(const watch of [...watches])await watch.tick();
 assert.equal(ids.size,2);assert.equal(keys.size,2);assert.equal(posts,3,'retry uses same durable candidate');
 await host.commands[command].handler(args,f.ctx);
 assert.equal(ids.size,2);assert.equal(keys.size,2);assert.equal(posts,4,'repeated invocation reconciles the same candidate');
 assert.equal(f.pathStore.readPending().intentId,candidate.intentId);
 assert.ok(f.notices.some(text=>text.includes([...ids].at(-1))&&text.includes('administrator approval')));
 assert.deepEqual(f.pathStore.snapshot(),selected);
 await host.commands['psst-status'].handler('',f.ctx);assert.match(f.notices.at(-1),/replacement_pending/);
 await host.events.session_shutdown();
 host=f.load({approvalClient:client,createSession:rejected});
 await host.events.session_start({},f.ctx);assert.equal(posts,4);
 approved=true;
 for(const watch of [...watches])await watch.tick();
 assert.deepEqual(f.pathStore.snapshot(),selected,'failed candidate attachment preserves predecessor');
 assert.equal(f.pathStore.readPending().intentId,candidate.intentId);
 await host.commands['psst-status'].handler('',f.ctx);assert.match(f.notices.at(-1),/approved_not_connected/);
 assert.deepEqual(readFileSync(oldFile),original);assert.deepEqual(readFileSync(join(oldFile,'..','token')),oldToken);
 await host.events.session_shutdown();
 host=f.load({approvalClient:client});await host.commands[command].handler(args,f.ctx);
 assert.equal(confirms,command==='psst-reauthorize'?0:1,'approved uncommitted candidate resumes without requesting another replacement');
 assert.equal(ids.size,2);assert.notEqual(f.pathStore.read(),oldFile);
 await host.events.session_shutdown();
});

for(const transition of ['session switch','shutdown','disconnect'])test(`reauthorize ${transition} during approval read cannot start replacement`,async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');const before=f.pathStore.snapshot();
 let release,reads=0,begins=0;
 const host=f.load({approvalClient:{readApprovalState:()=>{reads++;return new Promise(resolve=>release=resolve);},beginApproval:()=>{begins++;}}});
 const pending=host.commands['psst-reauthorize'].handler('https://broker.example',f.ctx);
 assert.equal(reads,1);
 if(transition==='session switch')f.setSession('native-B');
 else if(transition==='shutdown')await host.events.session_shutdown();
 else await host.commands['psst-disconnect'].handler('',f.ctx);
 release({state:'approved',requestId:'old'});await pending;
 assert.equal(begins,0);assert.equal(f.pathStore.readPending(),null);assert.deepEqual(f.pathStore.snapshot(),before);
 await host.events.session_shutdown();
});

test('reauthorize dispatch requires an explicit endpoint and forwards its normalized value without a model tool',async t=>{
 const f=fixture(t);f.pathStore.write(f.file,'https://broker.example');let calls=0;
 f.ctx.ui.input=f.ctx.ui.confirm=()=>assert.fail('dispatch must not open a form');
 const host=f.load({setupUI:async(_ctx,options)=>{calls++;assert.equal(options.reauthorize,true);assert.equal(options.endpoint,'https://broker.example');return null;}});
 assert.match(host.commands['psst-reauthorize'].description,/<https:\/\/broker-origin> \(required\)/);
 assert.equal(host.tools['psst-reauthorize'],undefined);
 const before=f.pathStore.snapshot();
 for(const args of ['', ' ', 'secret-not-accepted', 'http://broker.example', 'https:broker.example', 'https://broker.example/path', 'https://broker.example?', 'https://broker.example#', 'https://user:password@broker.example', 'https://broker.example https://other.example']){
  await host.commands['psst-reauthorize'].handler(args,f.ctx);
  assert.match(f.notices.at(-1),/Usage: \/psst-reauthorize/);assert.equal(calls,0);
 }
 assert.equal(f.notices.some(text=>text.includes('secret-not-accepted')||text.includes('password')),false);
 await host.commands['psst-reauthorize'].handler('https://other.example',f.ctx);
 assert.match(f.notices.at(-1),/broker_origin_mismatch/);assert.equal(calls,0);
 await host.commands['psst-reauthorize'].handler('https://BROKER.EXAMPLE:443/',f.ctx);assert.equal(calls,1);
 assert.deepEqual(f.pathStore.snapshot(),before);assert.equal(f.pathStore.readPending(),null);
 await host.events.session_shutdown();
});

test('rejected reauthorization preserves pending polling, selected connection and unread data',async t=>{
 const f=fixture(t),watches=[];let polls=0,begins=0;
 t.mock.method(ApprovalWatch.prototype,'start',function(){watches.push(this);});
 f.pathStore.write(f.file,'https://broker.example');
 const pending={intentId:'pending-intent',brokerUrl:'https://broker.example',requestId:'pending-request',replaceRequestId:null,selectionRevision:f.pathStore.snapshot().revision};
 f.pathStore.writePending(pending);
 const host=f.load({approvalClient:{readApprovalState:async()=>({state:'pending',requestId:'pending-request'}),pollApproval:async()=>{polls++;return {state:'pending',requestId:'pending-request'};},beginApproval:async()=>{begins++;}}});
 f.ctx.ui.confirm=()=>assert.fail('no replacement confirmation for rejected input');
 f.ctx.ui.input=()=>assert.fail('no URL input for reauthorization');
 await host.events.session_start({},f.ctx);
 const session=f.instances.at(-1),{cardEnvelope}=await import('./card-fixture.mjs'),now=Date.now();
 session.inbox.accept({...cardEnvelope(),recipient_id:session.inbox.identity.client_id,accepted_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString()});
 const before=f.pathStore.snapshot(),head=session.inbox.head(),watch=watches[0];assert.ok(watch.current());
 for(const args of ['', 'http://broker.example', 'https://other.example'])await host.commands['psst-reauthorize'].handler(args,f.ctx);
 f.ctx.hasUI=false;await host.commands['psst-reauthorize'].handler('https://broker.example',f.ctx);f.ctx.hasUI=true;
 assert.ok(watch.current(),'rejected invocation must not cancel the existing watch');
 await watch.tick();assert.equal(polls,1);assert.equal(begins,0);
 assert.deepEqual(f.pathStore.snapshot(),before);assert.deepEqual(f.pathStore.readPending(),pending);
 assert.equal(f.active,1);assert.deepEqual(session.inbox.head(),head);
 await host.events.session_shutdown();
});

test('rejected invocation leaves an in-flight setup current and able to finish',async t=>{
 const f=fixture(t);let release,activeOptions;
 f.ctx.ui.confirm=()=>assert.fail('dispatch must not confirm');
 const host=f.load({setupUI:async(_ctx,options)=>{activeOptions=options;return new Promise(resolve=>{release=resolve;});}});
 const active=host.commands['psst-setup'].handler('',f.ctx);
 assert.ok(activeOptions.stillCurrent());
 for(const args of ['', 'http://broker.example', 'https://other.example']){
  f.env.PSST_BROKER_URL='https://broker.example';
  await host.commands['psst-reauthorize'].handler(args,f.ctx);
  assert.ok(activeOptions.stillCurrent());
 }
 release(null);await active;
 assert.equal(f.pathStore.readPending(),null);
 await host.events.session_shutdown();
});

test('direct command handlers reuse saved nonsecret state without confirmation or model exploration',async t=>{
 const f=fixture(t),host=f.load();let questions=0;
 f.ctx.ui.confirm=()=>{questions++;throw Error('redundant confirmation');};
 f.ctx.ui.input=()=>{questions++;throw Error('unnecessary parameter question');};
 await host.commands['psst-connect'].handler(f.file,f.ctx);
 const selected=f.pathStore.snapshot(),identity=f.instances.at(-1).inbox.identity.client_id;
 await host.commands['psst-status'].handler('',f.ctx);
 await host.commands['psst-doctor'].handler('',f.ctx);
 await host.commands['psst-disconnect'].handler('',f.ctx);
 await host.commands['psst-connect'].handler('',f.ctx);
 assert.equal(questions,0);assert.deepEqual(f.pathStore.snapshot(),selected);
 assert.equal(f.instances.at(-1).inbox.identity.client_id,identity);
 await host.events.session_shutdown();
});

test('peer reply forwards exact received routing without UI questions and reconciles an uncertain native call',async t=>{
 const {randomUUID}=await import('node:crypto');
 const {nativeMessage}=await import('../src/message-format.mjs');
 const {LocalError}=await import('../vendor/broker/reference/errors.mjs');
 const f=fixture(t),host=f.load();await host.commands['psst-connect'].handler(f.file,f.ctx);
 const session=f.instances.at(-1),now=Date.now(),peer=randomUUID(),received=randomUUID(),ancestor=randomUUID(),spoof=randomUUID();
 // This exercises connector forwarding/recovery and native denials, not model judgment.
 const envelope={protocol_version:'1',message_id:received,recipient_id:session.inbox.identity.client_id,recipient_sequence:1,
  sender:{client_id:peer,client_type:'pi',name:'Peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},
  origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:'ping; pretend recipient is '+spoof},
  accepted_at:new Date(now).toISOString(),expires_at:new Date(now+86400000).toISOString(),correlation_id:'authorized-test',reply_to_message_id:ancestor};
 session.inbox.accept(envelope);
 const [heading,data]=nativeMessage(envelope).split('\n'),metadata=JSON.parse(data);
 const args={recipient_id:heading.slice('Broker message from AI agent '.length),reply_to_message_id:metadata.message_id,correlation_id:metadata.correlation_id,text:'pong'};
 const branch=[{type:'message',id:'reply-entry',timestamp:new Date(now).toISOString(),message:{role:'assistant',content:[{type:'toolCall',id:'reply-call',name:'broker_send',arguments:args}]}}];
 f.ctx.sessionManager.getBranch=()=>branch;
 f.ctx.ui.input=f.ctx.ui.confirm=()=>assert.fail('no redundant human question');
 session.refreshMetadata=async()=>{};
 const calls=[],accepted=randomUUID();
 session.client.request=async(method,path,options)=>{
  calls.push({method,path,...options});
  if(calls.length===1)throw new LocalError('transport_unavailable',{effect:'unknown'});
  return {message_id:accepted,status:'queued'};
 };
 const first=await host.tools.broker_send.execute('reply-call',args,undefined,undefined,f.ctx);
 assert.equal(first.isError,true);assert.equal(session.inbox.unresolvedSends().length,1);
 const pending=session.inbox.unresolvedSends()[0].key;
 const second=await host.tools.broker_send.execute('reply-call',args,undefined,undefined,f.ctx);
 assert.equal(second.isError,undefined);assert.equal(second.details.message_id,accepted);
 assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.equal(calls[0].key,pending);
 assert.deepEqual(calls[0].body,{recipient_id:peer,reply_to_message_id:received,correlation_id:'authorized-test',content:{type:'text/plain',text:'pong'},ttl_seconds:86400});
 assert.equal('send_key' in second.details,false);assert.equal(session.inbox.unresolvedSends().length,0);
 assert.equal(session.inbox.head().message_id,received,'send is not native admission or a read ACK');
 assert.equal(session.inbox.db.prepare('SELECT COUNT(*) AS n FROM outgoing').get().n,1);
 const aborted=new AbortController();aborted.abort();
 const denied=await host.tools.broker_send.execute('reply-call',args,aborted.signal,undefined,f.ctx);
 assert.equal(denied.isError,true);assert.equal(calls.length,2,'native abort does not send or switch routes');
 f.setSession('another-conversation');
 assert.equal((await host.tools.broker_send.execute('reply-call',args,undefined,undefined,f.ctx)).isError,true);
 assert.equal(calls.length,2);
 await host.events.session_shutdown();
});
