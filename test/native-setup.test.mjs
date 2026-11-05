import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeSetup,nativeBrokerSettings,reauthorizationEndpoint} from '../src/native-setup.mjs';
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

test('reauthorize uses the explicit matching target as replacement intent without any form',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';let begins=0;
 const ctx={hasUI:true,ui:{input:()=>assert.fail('no URL form'),confirm:()=>assert.fail('no redundant confirmation')}};
 for(const state of ['approved','revoked','denied','expired']){
  const result=await nativeSetup(ctx,{env:f.env,reauthorize:true,endpoint:brokerUrl,selection:{brokerUrl,approvalRequestId:'old'},
   resumeRequest:{brokerUrl,requestId:'old'},approvalClient:{readApprovalState:async()=>({state,requestId:'old'}),beginApproval:async options=>{
    begins++;assert.equal(options.replaceRequestId,'old');return {state:'pending',requestId:'new'};
   }}});
  assert.equal(result.requestId,'new');
 }
 assert.equal(begins,4);
});

test('reauthorize rejects missing, malformed and mismatched targets before approval reads or mutation',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';
 const forbidden=()=>assert.fail('rejected input must not reach UI, approval or writes');
 const ctx={hasUI:true,ui:{input:forbidden,confirm:forbidden}};
 const opts={env:f.env,reauthorize:true,selection:{brokerUrl},beforeBegin:forbidden,approvalClient:{readApprovalState:forbidden,beginApproval:forbidden}};
 for(const endpoint of [undefined,'','http://broker.example','https:broker.example','https://broker.example\\\\','https://broker.example?','https://broker.example#','https://broker.example/path','https://user:password@broker.example']){
  await assert.rejects(nativeSetup(ctx,{...opts,endpoint}),{code:'invalid_configuration'});
 }
 await assert.rejects(nativeSetup(ctx,{...opts,endpoint:'https://other.example'}),{code:'broker_origin_mismatch'});
});

test('reauthorization checks configured origins including bundle and pending-only targets without requiring a valid receipt',t=>{
 const f=fixture(t),brokerUrl='https://broker.example',other='https://other.example',file=join(f.root,'connection.json');
 writeFileSync(file,JSON.stringify({broker_url:brokerUrl,enrollment_receipt_file:'enrollment.json'}),{mode:0o600});
 for(const options of [{selection:{brokerUrl}},{pending:{brokerUrl}},{connectedUrl:brokerUrl},{env:{...f.env,PSST_BROKER_URL:brokerUrl}},{selection:{connectionFile:file}},{env:{...f.env,PSST_CONFIG_FILE:file}},{env:{...f.env,PSST_CONFIG:file}}]){
  assert.equal(reauthorizationEndpoint(brokerUrl,{env:f.env,...options}),brokerUrl);
  assert.throws(()=>reauthorizationEndpoint(other,{env:f.env,...options}),{code:'broker_origin_mismatch'});
 }
 assert.equal(reauthorizationEndpoint(brokerUrl,{env:f.env}),brokerUrl);
 assert.equal(reauthorizationEndpoint(brokerUrl,{env:{...f.env,PSST_CONFIG_FILE:file},selection:{brokerUrl:other}}),brokerUrl,'explicit bundle takes precedence over the installation selection');
});

test('reauthorize without a saved target uses its explicit endpoint without dialog capabilities',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';let begins=0,writes=0;
 const ctx={hasUI:true};
 const result=await nativeSetup(ctx,{env:f.env,reauthorize:true,endpoint:brokerUrl,beforeBegin:()=>writes++,approvalClient:{readApprovalState:async()=>null,beginApproval:async options=>{begins++;assert.equal(options.brokerUrl,brokerUrl);return {state:'pending',requestId:'new'};}}});
 assert.equal(result.brokerUrl,brokerUrl);assert.equal(begins,1);assert.equal(writes,1);
});

test('reauthorize session cancellation and host UI denial cannot persist intent or begin',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';let current=true;
 const forbidden=()=>assert.fail('canceled or denied command must not write or enroll');
 const opts={env:f.env,reauthorize:true,endpoint:brokerUrl,stillCurrent:()=>current,beforeBegin:forbidden,
  approvalClient:{readApprovalState:async()=>{current=false;return {state:'approved',requestId:'old'};},beginApproval:forbidden}};
 await assert.rejects(nativeSetup({hasUI:false},opts),{code:'native_input_unavailable'});
 assert.equal(current,true,'host UI denial must not read approval');
 assert.equal(await nativeSetup({hasUI:true},opts),null);
});

test('reauthorize resumes pending and approved uncommitted candidates without replacement or confirmation',async t=>{
 const f=fixture(t),brokerUrl='https://broker.example';
 const ctx={hasUI:true,ui:{confirm:()=>assert.fail('no redundant confirmation')}};
 for(const state of ['pending','approved']){
  const previous={state,requestId:'candidate',connectionFile:'/fixture/candidate.json'};
  const result=await nativeSetup(ctx,{env:f.env,reauthorize:true,endpoint:brokerUrl,selection:{brokerUrl,approvalRequestId:'old'},resumeRequest:{brokerUrl,requestId:'candidate'},
   approvalClient:{readApprovalState:async()=>previous,beginApproval:async options=>{assert.equal(options.replaceRequestId,undefined);return previous;}}});
  assert.equal(result.requestId,'candidate');
 }
});
