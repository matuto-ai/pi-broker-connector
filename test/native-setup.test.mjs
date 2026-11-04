import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeSetup,nativeBrokerSettings} from '../src/native-setup.mjs';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'pi-native-setup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const env={PI_CODING_AGENT_DIR:join(root,'agent')};return{root,env,settings:nativeBrokerSettings(env)};}
test('explicit native setup asks only URL and delegates durable request creation',async t=>{
 const f=fixture(t),shown=[];let calls=0;
 const ctx={hasUI:true,ui:{input:async title=>{shown.push(title);return'https://broker.example';},confirm:async()=>{throw Error('unexpected secret or confirmation');}}};
 const result=await nativeSetup(ctx,{env:f.env,approvalClient:{readApprovalState:async()=>null,beginApproval:async options=>{calls++;assert.equal(options.clientType,'pi');assert.equal(options.brokerUrl,'https://broker.example');assert.equal('pairingSecret' in options,false);return{state:'pending',requestId:'request-a'};}}});
 assert.equal(result.state,'pending');assert.equal(calls,1);assert.deepEqual(shown,['Psst broker HTTPS URL']);assert.equal(f.settings.read(),null);
});
test('cancel, environment mismatch and departed session never initiate enrollment',async t=>{
 const f=fixture(t);let calls=0;const opts={env:f.env,approvalClient:{readApprovalState:async()=>null,beginApproval:async()=>{calls++;}}};
 assert.equal(await nativeSetup({hasUI:true,ui:{input:async()=>undefined}},opts),null);
 const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example'}};
 assert.equal(await nativeSetup(ctx,{...opts,stillCurrent:()=>false}),null);
 await assert.rejects(nativeSetup(ctx,{...opts,env:{...f.env,PSST_BROKER_URL:'https://other.example'}}),{code:'broker_origin_mismatch'});assert.equal(calls,0);
});
test('pending resumes same request while terminal replacement requires explicit confirmation',async t=>{
 const f=fixture(t);let confirmed=0,options;
 const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example',confirm:async()=>{confirmed++;return true;}}};
 for(const state of ['pending','approved','denied','expired','revoked']){
  await nativeSetup(ctx,{env:f.env,approvalClient:{readApprovalState:async()=>({state,requestId:'prior'}),beginApproval:async o=>{options=o;return{state:'pending',requestId:'next'};}}});
  assert.equal(options.replaceRequestId,state==='pending'?undefined:'prior');
 }
 assert.equal(confirmed,4);
});
test('uncertain result never writes selection or creates a replacement',async t=>{
 const f=fixture(t);let calls=0;const ctx={hasUI:true,ui:{input:async()=> 'https://broker.example'}};
 await assert.rejects(nativeSetup(ctx,{env:f.env,approvalClient:{readApprovalState:async()=>null,beginApproval:async()=>{calls++;throw Error('fixture unknown');}}}));
 assert.equal(calls,1);assert.equal(f.settings.read(),null);
});

test('approved uncommitted candidate resumes, but selected predecessor requires confirmation',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';
 const previous={state:'approved',requestId:'prior',connectionFile:'/fixture/connection.json'};
 let confirms=0,begins=0,last;
 const ctx={hasUI:true,ui:{input:async()=>brokerUrl,confirm:async()=>{confirms++;return true;}}};
 const opts={env:f.env,resumeRequest:{brokerUrl,requestId:'prior'},approvalClient:{readApprovalState:async()=>previous,beginApproval:async o=>{begins++;last=o;return previous;}}};
 await nativeSetup(ctx,opts);assert.equal(confirms,0);assert.equal(last.replaceRequestId,undefined);
 for(const selection of [{brokerUrl,approvalRequestId:'prior'},{brokerUrl,connectionFile:previous.connectionFile}]){
  await nativeSetup(ctx,{...opts,selection});assert.equal(last.replaceRequestId,'prior');
 }
 assert.equal(confirms,2);assert.equal(begins,3);
 ctx.ui.confirm=async()=>false;
 assert.equal(await nativeSetup(ctx,{...opts,selection:{brokerUrl,approvalRequestId:'prior'}}),null);
 assert.equal(begins,3);
});

test('replacement confirmation canceled by session transition cannot begin a request',async t=>{
 const f=fixture(t);let current=true,begins=0;
 await nativeSetup({hasUI:true,ui:{input:async()=> 'https://broker.example',confirm:async()=>{current=false;return true;}}},{
  env:f.env,stillCurrent:()=>current,approvalClient:{readApprovalState:async()=>({state:'revoked',requestId:'old'}),beginApproval:async()=>begins++}});
 assert.equal(begins,0);
});

test('reauthorize reuses configured target and confirms creation without revoking old access',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';let confirms=0,begins=0;
 const ctx={hasUI:true,ui:{input:async()=>{throw Error('configured origin should be reused');},confirm:async(title,text)=>{
  confirms++;assert.match(text,/Target: https:\/\/broker.example/);assert.match(text,/does not revoke/);assert.match(text,/manual revocation/);return true;
 }}};
 for(const state of ['approved','revoked','denied','expired']){
  const result=await nativeSetup(ctx,{env:f.env,reauthorize:true,selection:{brokerUrl,approvalRequestId:'old'},
   resumeRequest:{brokerUrl,requestId:'old'},approvalClient:{readApprovalState:async()=>({state,requestId:'old'}),beginApproval:async options=>{
    begins++;assert.equal(options.replaceRequestId,'old');return {state:'pending',requestId:'new'};
   }}});
  assert.equal(result.requestId,'new');
 }
 assert.equal(confirms,4);assert.equal(begins,4);
});

test('reauthorize cancellation does not persist intent or begin; pending retries do not confirm a new candidate',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';let begins=0,writes=0,confirms=0;
 const opts={env:f.env,reauthorize:true,selection:{brokerUrl,approvalRequestId:'old'},beforeBegin:()=>writes++,
  approvalClient:{readApprovalState:async()=>({state:'approved',requestId:'old'}),beginApproval:async()=>{begins++;return {state:'pending',requestId:'candidate'};}}};
 const ctx={hasUI:true,ui:{confirm:async()=>{confirms++;return false;}}};
 assert.equal(await nativeSetup(ctx,opts),null);assert.equal(writes,0);assert.equal(begins,0);
 opts.approvalClient.readApprovalState=async()=>({state:'pending',requestId:'candidate'});
 await nativeSetup(ctx,opts);assert.equal(confirms,1);assert.equal(begins,1);assert.equal(writes,1);
});
