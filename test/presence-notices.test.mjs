import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Inbox,newSessionIdentity} from '../vendor/broker/reference/inbox.mjs';
import {PresenceNotices,presenceText,PRESENCE_TYPE} from '../src/presence-notices.mjs';
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'pi-presence-')),identity=newSessionIdentity('pi'),file=join(directory,'session.jsonl');writeFileSync(file,'');
 let inbox=new Inbox({directory,identity}),alive=true,allowed=true,idle=true,behavior='persist',ackFails=false,page;
 const sent=[],calls=[],acks=[];
 const event={event_id:randomUUID(),recipient_id:randomUUID(),type:'recipient_offline',presence_state:'disconnected',last_heartbeat_at:new Date(0).toISOString(),created_at:new Date(600000).toISOString(),observed_at:new Date(600000).toISOString(),messages:[{message_id:randomUUID(),delivery_state:'queued',delivery_uncertain:false}],has_more_messages:false};
 const client={policy:{presence_events:true},async presenceEvents(filters){calls.push(filters);return page?await page(filters):{events:[event],next_cursor:null};},async acknowledgePresenceEvent(id){acks.push(id);if(ackFails)throw Error('lost');}};
 const session={get inbox(){return inbox;},client,isAlive:()=>alive,deliveryAllowed:()=>allowed};
 const pi={sendMessage(message){sent.push(message);if(behavior==='throw')throw Error('unknown');if(behavior==='persist')appendFileSync(file,JSON.stringify({type:'custom_message',id:randomUUID(),...message})+'\n');}};
 const ctx={isIdle:()=>idle,hasPendingMessages:()=>false,sessionManager:{getSessionFile:()=>file}};
 let worker=new PresenceNotices({session,pi,ctx});
 t.after(async()=>{await worker.stop();inbox.close();rmSync(directory,{recursive:true,force:true});});
 return {get worker(){return worker;},get inbox(){return inbox;},event,client,sent,calls,acks,file,ctx,setPage:f=>page=f,setIdle:v=>idle=v,setBehavior:v=>behavior=v,setAckFails:v=>ackFails=v,setAllowed:v=>allowed=v,async reopen(){await worker.stop();inbox.close();inbox=new Inbox({directory,identity});worker=new PresenceNotices({session,pi,ctx});}};
}
test('capability gate, idle pause, durable presentation then notice-only ACK',async t=>{
 const f=fixture(t);f.client.policy.presence_events=false;await f.worker.tick();assert.equal(f.calls.length,0);f.client.policy.presence_events=true;
 f.setIdle(false);await f.worker.tick();assert.equal(f.sent.length,0);assert.equal(f.acks.length,0);f.setIdle(true);await f.worker.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].customType,PRESENCE_TYPE);assert.equal(f.acks.length,0);
 await f.worker.tick();assert.deepEqual(f.acks,[f.event.event_id]);assert.equal(f.inbox.head(),null);await f.worker.tick();assert.equal(f.sent.length,1);
});
test('throw/lost native result persists uncertainty across reopen and reconciles exact receipt',async t=>{
 const f=fixture(t);f.setBehavior('throw');await f.worker.tick();await f.reopen();await f.worker.tick();assert.equal(f.sent.length,1);assert.equal(f.acks.length,0);
 appendFileSync(f.file,JSON.stringify({type:'custom_message',id:'receipt',...f.sent[0]})+'\n');await f.worker.tick();assert.equal(f.acks.length,1);assert.equal(f.sent.length,1);
});
test('lost ACK retries idempotently without native replay across restart',async t=>{
 const f=fixture(t);await f.worker.tick();f.setAckFails(true);await f.worker.tick();await f.reopen();f.setAckFails(false);await f.worker.tick();assert.equal(f.acks.length,2);assert.equal(f.sent.length,1);
});
test('empty continuation followed, each fresh cycle starts without cursor',async t=>{
 const f=fixture(t);f.setPage(filters=>filters.cursor?{events:[],next_cursor:null}:{events:[],next_cursor:'next'});await f.worker.tick();await f.worker.tick();assert.deepEqual(f.calls,[{limit:10},{limit:10,cursor:'next'},{limit:10},{limit:10,cursor:'next'}]);
});
test('pause/stop suppress network and presentation; obsolete pending event is not replayed',async t=>{
 const f=fixture(t);f.setIdle(false);await f.worker.tick();f.setIdle(true);f.setPage(()=>({events:[],next_cursor:null}));await f.worker.tick();assert.equal(f.sent.length,0);f.setAllowed(false);const count=f.calls.length;await f.worker.tick();assert.equal(f.calls.length,count);await f.worker.stop();await f.worker.tick();assert.equal(f.calls.length,count);
});
test('untrusted bodies omitted and metadata strictly validated',t=>{
 const f=fixture(t);assert.doesNotMatch(presenceText({...f.event,body:'secret message body'}),/secret message body/);assert.throws(()=>presenceText({...f.event,recipient_id:'evil\ntext'}));
});
test('durable journal failure before commit never presents',async t=>{
 const f=fixture(t);f.inbox.failurePoint=point=>{if(point==='before_commit')throw Error('disk');};await f.worker.tick();assert.equal(f.sent.length,0);assert.equal(f.acks.length,0);f.inbox.failurePoint=()=>{};
});
test('capacity-limited snapshot preserves pending; cursor work is bounded',async t=>{
 const f=fixture(t);f.setIdle(false);await f.worker.tick();
 f.setPage(()=>({events:[],next_cursor:null,capacity_limited:true}));await f.worker.tick();
 assert.equal(f.inbox.db.prepare("SELECT COUNT(*) AS n FROM pi_presence_notices WHERE state='pending'").get().n,1);
 let pages=0;f.setPage(()=>({events:[],next_cursor:String(++pages)}));await f.worker.tick();assert.equal(pages,32);
 assert.equal(f.inbox.db.prepare("SELECT COUNT(*) AS n FROM pi_presence_notices WHERE state='pending'").get().n,1);
});


test('presence notices wait for human draft and keep prior receipt recovery independent',async t=>{
 const f=fixture(t);let draft='unfinished approval response';f.ctx.hasUI=true;f.ctx.ui={getEditorText:()=>draft};
 await f.worker.tick();assert.equal(f.sent.length,0);assert.equal(f.acks.length,0);
 assert.equal(f.inbox.db.prepare('SELECT state FROM pi_presence_notices').get().state,'pending');
 draft='';await f.worker.tick();assert.equal(f.sent.length,1);
 draft='still typing';await f.worker.tick();assert.equal(f.acks.length,1);assert.equal(f.sent.length,1);assert.equal(draft,'still typing');
});
