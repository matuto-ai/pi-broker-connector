import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { BrokerClient } from '../vendor/broker/reference/client.mjs';
import { PresenceNotices } from '../src/presence-notices.mjs';
const { httpFixture, registration, uuid, sendBody } = await import(process.env.PSST_MESSAGE_TEST_SOURCE ? pathToFileURL(join(resolve(process.env.PSST_MESSAGE_TEST_SOURCE),'test/helpers.mjs')).href : './fixtures/broker/test/helpers.mjs');

async function setup(t) {
  const f = await httpFixture(t), tokenFile = join(f.dir, 'token');
  writeFileSync(tokenFile, f.a.token, {mode:0o600});
  const identity = newSessionIdentity('pi'), directory = join(f.dir, 'notice-client');
  const inbox = new Inbox({directory,identity,now:()=>f.now});
  t.after(()=>inbox.close());
  const client = new BrokerClient({url:f.base,tokenFile,insecureDevelopment:true,inbox,now:()=>f.now,maxAttempts:1});
  await client.register(registration().metadata);
  const recipient=registration();f.store.register(f.b.entry,recipient);
  const sent=f.store.send(f.a.entry,identity.client_id,1,uuid(),sendBody(recipient.client_id,'private payload must not appear in notice'));
  f.store.disconnect(f.b.entry,recipient.client_id,1);
  const file=join(f.dir,'native-session.jsonl');writeFileSync(file,'',{mode:0o600});
  let idle=true, persist=true; const presented=[];
  const session={inbox,client,isAlive:()=>true,deliveryAllowed:()=>true};
  const ctx={sessionManager:{getSessionFile:()=>file},isIdle:()=>idle,hasPendingMessages:()=>false};
  const pi={sendMessage(message){presented.push(message);if(persist)appendFileSync(file,JSON.stringify({type:'custom_message',id:uuid(),...message})+'\n');}};
  const make=()=>new PresenceNotices({session,pi,ctx});
  return {f,client,inbox,recipient,sent,presented,make,setIdle:v=>idle=v,setPersist:v=>persist=v};
}

test('real HTTP offline threshold, durable native handoff and ACK preserve queued mail',async t=>{
  const x=await setup(t),notice=x.make();t.after(()=>notice.stop());
  x.f.advance(599999);await notice.tick();assert.equal(x.presented.length,0);
  x.f.advance(1);await notice.tick();assert.equal(x.presented.length,1);
  assert.doesNotMatch(x.presented[0].content,/private payload/);
  assert.match(x.presented[0].content,/not an agent instruction/);
  assert.equal((await x.client.presenceEvents()).events.length,1,'native durable record must be reconciled before ACK');
  await notice.tick();assert.equal((await x.client.presenceEvents()).events.length,0);
  await notice.tick();assert.equal(x.presented.length,1);
  assert.equal(x.f.store.receipt(x.f.a.entry,x.inbox.identity.client_id,x.sent.message_id).delivery_state,'queued');
});

test('lost real ACK response and consumer restart never repeat native presentation',async t=>{
  const x=await setup(t);let notice=x.make();t.after(()=>notice.stop());
  x.f.advance(600000);await notice.tick();
  const acknowledge=x.client.acknowledgePresenceEvent.bind(x.client);let fail=true;
  x.client.acknowledgePresenceEvent=async(...args)=>{const result=await acknowledge(...args);if(fail){fail=false;throw Error('lost ack response');}return result;};
  await notice.tick();assert.equal((await x.client.presenceEvents()).events.length,0);
  await notice.stop();notice=x.make();await notice.tick();await notice.tick();
  assert.equal(x.presented.length,1);
  assert.equal(x.inbox.db.prepare('SELECT state FROM pi_presence_notices').get().state,'acked');
});

test('uncertain native handoff is retained without ACK or automatic retry',async t=>{
  const x=await setup(t);let notice=x.make();t.after(()=>notice.stop());
  x.setPersist(false);x.f.advance(600000);await notice.tick();await notice.tick();
  await notice.stop();notice=x.make();await notice.tick();
  assert.equal(x.presented.length,1);
  assert.equal((await x.client.presenceEvents()).events.length,1);
  assert.equal(x.inbox.db.prepare('SELECT state FROM pi_presence_notices').get().state,'presenting');
});

test('obsolete ACK does not block the next real absence episode',async t=>{
  const x=await setup(t),notice=x.make();t.after(()=>notice.stop());
  x.f.advance(600000);await notice.tick();
  const old=x.presented[0].details.message_id;
  x.f.store.register(x.f.b.entry,{...x.recipient,previous_epoch:1,connection_id:uuid()});
  assert.equal((await x.client.presenceEvents()).events.length,0,'reconnect removes the old broker event');
  await notice.tick();
  x.f.advance(600000);await notice.tick();
  assert.equal(x.presented.length,2,'an obsolete ACK must not permanently block later notices');
  assert.notEqual(x.presented[1].details.message_id,old);
});

test('pending presentation refreshes metadata after one queued message is cancelled',async t=>{
  const x=await setup(t),notice=x.make();t.after(()=>notice.stop());
  const second=x.f.store.send(x.f.a.entry,x.inbox.identity.client_id,1,uuid(),sendBody(x.recipient.client_id,'second private payload'));
  x.setIdle(false);x.f.advance(600000);await notice.tick();assert.equal(x.presented.length,0);
  await x.client.reconnect({verifySession:()=>true});
  x.f.store.cancel(x.f.a.entry,x.inbox.identity.client_id,x.client.attachment.lease_epoch,x.sent.message_id);
  x.setIdle(true);await notice.tick();assert.equal(x.presented.length,1);
  assert.ok(!x.presented[0].content.includes(x.sent.message_id),'cancelled message must not appear as pending');
  assert.ok(x.presented[0].content.includes(second.message_id));
});

test('shutdown drains an outstanding real HTTP poll without native handoff',async t=>{
  const x=await setup(t),notice=x.make();x.f.advance(600000);
  const poll=x.client.presenceEvents.bind(x.client);let entered,release;
  const started=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
  x.client.presenceEvents=async(...args)=>{const result=await poll(...args);entered();await barrier;return result;};
  const ticking=notice.tick();await started;const stopping=notice.stop();release();await Promise.all([ticking,stopping]);
  assert.equal(x.presented.length,0);
  assert.equal((await poll()).events.length,1,'stopping must not acknowledge an unpresented event');
});

test('obsolete never-presented backlog frees capacity after a complete authoritative scan',async t=>{
  const x=await setup(t),notice=x.make();t.after(()=>notice.stop());
  x.inbox.transaction(()=>{
    const insert=x.inbox.db.prepare("INSERT INTO pi_presence_notices(event_id,content,state,created_at) VALUES(?,?,'pending',?)");
    for(let i=0;i<256;i++)insert.run(uuid(),'obsolete never-presented metadata',i);
  });
  x.f.advance(600000);await notice.tick();await notice.tick();
  assert.equal(x.presented.length,1,'obsolete pending events must not permanently saturate the bounded journal');
});

test('bounded continuation still presents a valid prefix without pruning unseen pending notices',async t=>{
  const x=await setup(t),notice=x.make();t.after(()=>notice.stop());x.f.advance(600000);
  const event=(await x.client.presenceEvents()).events[0],unseen=uuid();
  x.inbox.transaction(()=>x.inbox.db.prepare("INSERT INTO pi_presence_notices(event_id,content,state,created_at) VALUES(?,?,'pending',0)").run(unseen,'unseen pending event'));
  let calls=0;
  x.client.presenceEvents=async()=>{calls++;return {events:Array.from({length:10},()=>({...event,event_id:uuid()})),next_cursor:String(calls),capacity_limited:false};};
  await notice.tick();
  assert.ok(calls<=32,'one cycle must respect the page budget');
  assert.equal(x.presented.length,1,'large backlogs must not starve all presentation');
  assert.equal(x.inbox.db.prepare('SELECT state FROM pi_presence_notices WHERE event_id=?').get(unseen)?.state,'pending','a partial scan cannot prove an unseen event obsolete');
});
