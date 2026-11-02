import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {PiBrokerSession} from '../src/session.mjs';
import {httpFixture} from './fixtures/broker/test/helpers.mjs';

function factory(f, version=2) {
 const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});
 const config={url:f.base,tokenFile,stateDirectory:join(f.dir,'pi-state'),name:'Synthetic Pi'};
 return id=>new PiBrokerSession({config,hostSessionId:id,currentSessionId:()=>id,clientOptions:{registrationVersion:version,insecureDevelopment:true,now:()=>f.now,maxAttempts:1}});
}
for(const version of [1,2])test(`Pi baseline plus SDK overlay: registration v${version}, cleanup disabled, resume is isolated`,async t=>{
 const f=await httpFixture(t),make=factory(f,version),a=make('A'),b=make('B');t.after(async()=>{await a.close();await b.close();});
 await a.start();await b.start();const id=a.inbox.identity.client_id;assert.notEqual(id,b.inbox.identity.client_id);
 if(version===2) assert.ok(b.client.attachment.lease_epoch>a.client.attachment.lease_epoch);
 await a.close();const resumed=make('A');t.after(()=>resumed.close());await resumed.start();assert.equal(resumed.inbox.identity.client_id,id);
});
test('Pi expiry selects durable empty incarnation; reload retains it and old work remains isolated',async t=>{
 const f=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}}),make=factory(f),a=make('A');t.after(()=>a.close());
 await a.start();const id=a.inbox.identity.client_id;await a.runtime.stop({closeSession:false});a.inbox.setState('claim_pending',{key:'preserved-old-uncertainty'});const oldSend=a.inbox.prepareSend({recipient_id:id,content:{type:'text/plain',text:'must never migrate'}});await a.close();
 f.advance(172800000);f.store.sweep();const expired=make('A');t.after(()=>expired.close());
 await expired.start();const fresh=expired.inbox.identity.client_id;
 assert.notEqual(fresh,id);assert.equal(expired.inbox.getState('claim_pending'),null);assert.equal(expired.inbox.unresolvedSends().length,0);assert.ok(expired.rootInbox.outgoing(oldSend));
 assert.deepEqual(expired.rootInbox.getState('claim_pending'),{key:'preserved-old-uncertainty'});
 assert.throws(()=>make('A'),e=>e.code==='owner_conflict');
 await expired.close();
 const reload=make('A');t.after(()=>reload.close());assert.equal(reload.inbox.identity.client_id,fresh);
 await reload.start();assert.equal(reload.inbox.identity.client_id,fresh);
 assert.deepEqual(reload.rootInbox.getState('claim_pending'),{key:'preserved-old-uncertainty'});
 await reload.close();assert.throws(()=>factory(f,1)('A'),e=>e.code==='session_mismatch');
 const pointer=JSON.parse(readFileSync(reload.pointerFile,'utf8'));pointer.identity.client_type='claude';writeFileSync(reload.pointerFile,JSON.stringify(pointer));
 assert.throws(()=>make('A'),e=>e.code==='session_mismatch');
});

test('Pi inactivity is resumable and does not terminally close the native binding',async t=>{
 const f=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}});
 const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});let selected='A';
 const a=new PiBrokerSession({config:{url:f.base,tokenFile,stateDirectory:join(f.dir,'pi-state'),name:'Synthetic Pi'},hostSessionId:'A',currentSessionId:()=>selected,clientOptions:{registrationVersion:2,insecureDevelopment:true,now:()=>f.now,maxAttempts:1}});t.after(()=>a.close());
 await a.start();const id=a.inbox.identity.client_id;selected='B';assert.equal(await a.runtime.checkAlive(),false);await a.runtime.stop({closeSession:false});
 assert.equal(f.store.session(f.a.entry,id).closed,false);assert.equal(f.store.session(f.a.entry,id).presence_state,'disconnected');
});

test('uncertain pointer-directory fsync stops before registration; reload reconciles same pointer',async t=>{
 const f=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}}),make=factory(f),old=make('A');
 await old.start();await old.close();f.advance(172800000);f.store.sweep();
 const next=make('A');t.after(()=>next.close());
 const original=fs.fsyncSync;let calls=0;
 fs.fsyncSync=function(fd){if(++calls===3)throw Object.assign(new Error('synthetic fsync uncertainty'),{code:'EIO'});return original(fd);};syncBuiltinESMExports();
 try { await assert.rejects(next.start(),e=>e.code==='EIO'); }
 finally {fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
 const pointer=JSON.parse(readFileSync(next.pointerFile,'utf8'));await next.close();
 const reload=make('A');t.after(()=>reload.close());assert.equal(reload.inbox.identity.client_id,pointer.identity.client_id);
 await reload.start();assert.equal(reload.inbox.identity.client_id,pointer.identity.client_id);
});

test('running native expiry rebuilds extension owner and tools only for the same selected conversation',async t=>{
 const {installExtension}=await import('../src/extension.mjs');
 const f=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}});
 const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});
 const config={url:f.base,tokenFile,stateDirectory:join(f.dir,'state'),name:'Pi',registrationVersion:2};
 const instances=[],events={},tools={};let nativeId='A';
 const ctx={hasUI:false,sessionManager:{getSessionId:()=>nativeId}};
 installExtension({on:(n,fn)=>events[n]=fn,registerCommand(){},registerTool:tool=>tools[tool.name]=tool},
  {Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})},
  {env:{PSST_CONFIG_FILE:'/synthetic-config'},configReader:()=>config,pathStore:{isDisconnected:()=>false},
   createSession:options=>{const s=new PiBrokerSession({...options,clientOptions:{insecureDevelopment:true,now:()=>f.now,maxAttempts:1}});instances.push(s);return s;}});
 t.after(()=>events.session_shutdown());await events.session_start({},ctx);
 const old=instances[0],id=old.inbox.identity.client_id;old.inbox.setState('claim_pending',{key:'old-only'});
 f.advance(172980000);f.store.sweep();let error;try{await old.runtime.heartbeatOnce();}catch(e){error=e;}
 await old.runtime.handleTransportError(error,old.runtime.controller.signal,{ownedSessionOperation:true});
 let result;
 for(let i=0;i<100;i++){
  result=await tools.broker_identity.execute('identity',{},undefined,undefined,ctx);
  if(result.details?.client_id && result.details.client_id!==id)break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(instances.length,2);assert.notEqual(result.details.client_id,id);
 assert.notEqual(instances[1].inbox.getState('claim_pending')?.key,'old-only');
 assert.deepEqual(instances[1].rootInbox.getState('claim_pending'),{key:'old-only'});
 nativeId='B';instances[1].onDiagnostic({code:'session_expired'});
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(instances.length,2);
});

test('bundle registration opt-in accepts only exact versions, not null or coercions',async t=>{
 const {readConfig}=await import('../src/config.mjs');const f=await httpFixture(t);
 const path=join(f.dir,'connection.json');const bundle={format:'broker-client-bundle-v1',protocol_version:'1',file_paths_relative_to:'connection_file_directory',authorization_header:'Authorization',authorization_scheme:'Bearer',insecure_development:false,broker_url:'https://example.invalid',token_file:'token',allowed_client_types:['pi']};
 for(const value of [undefined,1,2,null,'2',0,true]){
  writeFileSync(path,JSON.stringify({...bundle,...(value===undefined?{}:{registration_version:value})}),{mode:0o600});
  if(value===undefined||value===1||value===2)assert.equal(readConfig({PSST_STATE_DIR:join(f.dir,'config-state')},path).registrationVersion,value??1);
  else assert.throws(()=>readConfig({},path),e=>e.code==='invalid_configuration');
 }
});

test('superseded same-native startup cannot create a fresh incarnation after expiry proof await',async t=>{
 const {installExtension}=await import('../src/extension.mjs');const {BrokerClient}=await import('../vendor/broker/reference/client.mjs');
 const f=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}}),make=factory(f),prior=make('A');
 await prior.start();await prior.close();f.advance(172800000);f.store.sweep();
 const config={url:f.base,tokenFile:join(f.dir,'token'),stateDirectory:join(f.dir,'pi-state'),name:'Pi',registrationVersion:2};
 const events={};let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const original=BrokerClient.prototype.createReplacementInbox;
 BrokerClient.prototype.createReplacementInbox=async function(options){entered();await gate;return original.call(this,options);};
 const ctx={hasUI:false,sessionManager:{getSessionId:()=>'A'}};
 installExtension({on:(n,fn)=>events[n]=fn,registerCommand(){},registerTool(){}},
  {Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})},
  {env:{PSST_CONFIG_FILE:'/synthetic-config'},configReader:()=>config,pathStore:{isDisconnected:()=>false},
   createSession:options=>new PiBrokerSession({...options,clientOptions:{insecureDevelopment:true,now:()=>f.now,maxAttempts:1}})});
 try {
  const start=events.session_start({},ctx);await began;
  const shutdown=events.session_shutdown();release();await Promise.all([start,shutdown]);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
  assert.equal(fs.existsSync(prior.pointerFile),false);
 }finally{release();BrokerClient.prototype.createReplacementInbox=original;await events.session_shutdown();}
});
