// Actual official SDK/event runner + local faux model. UI values and broker events
// are controlled fixtures, not authenticated user acceptance or a real TUI test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { NativeDelivery } from '../src/native-delivery.mjs';
import { NativeInputBoundary } from '../src/native-boundary.mjs';
import { PresenceNotices } from '../src/presence-notices.mjs';
const host=process.env.PI_TEST_INSTALL;
if(!host)throw Error('Set PI_TEST_INSTALL to official Pi 1.4.0');
const base=join(resolve(host),'node_modules/@earendil-works/pi-coding-agent');
assert.equal(JSON.parse(readFileSync(join(base,'package.json'))).version,'1.4.0');
const root=mkdtempSync(join(tmpdir(),'pi-human-boundary-'));
process.env.PI_CODING_AGENT_DIR=join(root,'agent');process.env.HOME=root;process.env.PI_OFFLINE='1';
const load=file=>import(pathToFileURL(join(base,'dist',file)));
const {createAgentSession}=await load('core/sdk.js');
const {ModelRuntime}=await load('core/model-runtime.js');
const {DefaultResourceLoader}=await load('core/resource-loader.js');
const {SessionManager}=await load('core/session-manager.js');
const {fauxProvider,fauxAssistantMessage}=await import(pathToFileURL(join(resolve(host),'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
const until=async predicate=>{for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('official host boundary timed out');};
test('official Pi draft/prompt/abort boundaries preserve both native journals',async t=>{
 let api,ctx,boundary,delivery,draft='',finishPrompt;
 const runtime=await ModelRuntime.create({authPath:join(root,'empty-auth.json'),modelsPath:null,refreshOnCreate:false});
 const faux=fauxProvider({tokensPerSecond:100000});runtime.registerNativeProvider(faux.provider);
 const loader=new DefaultResourceLoader({cwd:root,agentDir:join(root,'agent'),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  extensionFactories:[native=>{api=native;boundary=new NativeInputBoundary(api,()=>delivery);api.on('session_start',(_event,value)=>ctx=value);} ]});
 await loader.reload();const manager=SessionManager.create(root,join(root,'sessions'));
 const {session}=await createAgentSession({cwd:root,agentDir:join(root,'agent'),modelRuntime:runtime,model:faux.getModel(),resourceLoader:loader,sessionManager:manager,noTools:'all'});
 await session.bindExtensions({mode:'tui',uiContext:{getEditorText:()=>draft,confirm:()=>new Promise(resolve=>finishPrompt=resolve)}});
 const identity=newSessionIdentity('pi'),inbox=new Inbox({directory:join(root,'inbox'),identity});
 const event={event_id:randomUUID(),recipient_id:randomUUID(),type:'recipient_offline',presence_state:'disconnected',last_heartbeat_at:new Date(0).toISOString(),created_at:new Date(600000).toISOString(),observed_at:new Date(600000).toISOString(),messages:[],has_more_messages:false};
 let acknowledged=false;
 const adapter={inbox,isAlive:()=>true,deliveryAllowed:()=>true,client:{policy:{presence_events:true},presenceEvents:async()=>({events:acknowledged?[]:[event],next_cursor:null}),acknowledgePresenceEvent:async()=>{acknowledged=true;}}};
 delivery=new NativeDelivery({session:adapter,pi:api,ctx,canStart:()=>boundary.allows(ctx)});
 const notices=new PresenceNotices({session:adapter,pi:api,ctx,canStart:()=>!delivery.humanPaused&&boundary.allows(ctx)});
 t.after(async()=>{delivery.stop();await notices.stop();inbox.close();session.dispose();rmSync(root,{recursive:true,force:true});});
 const envelope=sequence=>({protocol_version:'1',message_id:randomUUID(),recipient_id:identity.client_id,recipient_sequence:sequence,sender:{client_id:randomUUID(),client_type:'pi',name:'peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:'yes'},accepted_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),correlation_id:null,reply_to_message_id:null});
 inbox.accept(envelope(1));draft='unfinished human decision';
 delivery.tick();await notices.tick();assert.equal(faux.state.callCount,0);assert.equal(inbox.head().state,'pending');assert.equal(draft,'unfinished human decision');
 draft='';const prompt=ctx.ui.confirm('Permission','Human decision required');await until(()=>boundary.promptActive);
 assert.equal(ctx.isIdle(),true);assert.equal(ctx.hasPendingMessages(),false);
 delivery.tick();await notices.tick();assert.equal(faux.state.callCount,0);assert.equal(inbox.head().state,'pending');assert.equal(acknowledged,false);
 finishPrompt(false);assert.equal(await prompt,false);await until(()=>!boundary.promptActive);
 faux.appendResponses([fauxAssistantMessage('peer response'),fauxAssistantMessage('notice response')]);
 delivery.tick();await until(()=>faux.state.callCount===1&&session.isIdle);delivery.tick();assert.equal(inbox.head(),null);
 await notices.tick();await until(()=>faux.state.callCount===2&&session.isIdle);await notices.tick();assert.equal(acknowledged,true);
 // The real abort API emits agent_settled.aborted; a later peer body "yes" cannot clear it.
 let busy=false;faux.appendResponses([async(_context,options)=>{busy=true;await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});return fauxAssistantMessage('aborted');}]);
 const running=session.prompt('human starts work');await until(()=>busy);inbox.accept(envelope(2));
 await session.abort();await running;assert.equal(delivery.humanPaused,true);assert.equal(session.isIdle,true);
 event.event_id=randomUUID();acknowledged=false;
 const count=faux.state.callCount;for(let i=0;i<3;i++){delivery.tick();await notices.tick();}
 assert.equal(faux.state.callCount,count);assert.equal(inbox.head().state,'pending');assert.equal(acknowledged,false);
 assert.equal(inbox.db.prepare('SELECT state FROM pi_presence_notices WHERE event_id=?').get(event.event_id).state,'pending');
 faux.appendResponses([fauxAssistantMessage('human resumed'),fauxAssistantMessage('queued peer response'),fauxAssistantMessage('queued notice response')]);
 await session.prompt('continue',{source:'interactive'});assert.equal(delivery.humanPaused,false);
 delivery.tick();await until(()=>faux.state.callCount===count+2&&session.isIdle);delivery.tick();assert.equal(inbox.head(),null);
 await notices.tick();await until(()=>faux.state.callCount===count+3&&session.isIdle);await notices.tick();assert.equal(acknowledged,true);
 const rows=readFileSync(manager.getSessionFile(),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.filter(row=>row.type==='custom_message'&&row.customType==='psst-agent-message').length,2);
 assert.equal(rows.filter(row=>row.type==='custom_message'&&row.customType==='psst-transport-notice').length,2);
});
