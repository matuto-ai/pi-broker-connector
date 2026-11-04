// End-to-end official bundled CLI/TUI, official local faux model, and genuine
// authenticated disposable TLS broker. No production accounts or real inference.
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
if(!host||!source)throw Error('Set PI_TEST_INSTALL and PSST_TEST_SOURCE to reviewed fixtures');
const base=join(resolve(host),'node_modules/@earendil-works/pi-coding-agent');
assert.equal(JSON.parse(readFileSync(join(base,'package.json'))).version,'1.4.0');
const {approvalTlsFixture}=await import(pathToFileURL(join(resolve(source),'test/approval-tls-fixture.mjs')));

test('bundled official Pi: native tool roundtrip, same-conversation /resume, draft/prompt/abort boundaries and revocation', {timeout:180000},async t=>{
 const f=await approvalTlsFixture(t);
 const fixture=join(f.directory,'faux-fixture.ts');
 // This second extension only provides the official deterministic model, records
 // observations, and opens an actual supported UI prompt. It never delivers mail,
 // calls broker tools, modifies connector state, or substitutes a host API.
 writeFileSync(fixture,`
import {appendFileSync,writeFileSync} from 'node:fs';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(join(resolve(host),'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'))};
export default function(pi){
 const log=(event,value={})=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({event,...value})+'\\n');
 const faux=fauxProvider({api:'native-acceptance-faux',tokensPerSecond:100000});
 const answer=async(context,options)=>{
  const last=context.messages.at(-1);log('model',{last});
  if(last?.role==='user'){
   const text=typeof last.content==='string'?last.content:last.content.filter(x=>x.type==='text').map(x=>x.text).join('\\n');
   if(text.startsWith('SEND '))return fauxAssistantMessage(fauxToolCall('broker_send',JSON.parse(text.slice(5))),{stopReason:'toolUse'});
   if(text==='HOLD_FOR_ABORT'){log('holding');await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});}
  }
  return fauxAssistantMessage('Fixture model completed.');
 };
 faux.setResponses(Array.from({length:200},()=>answer));pi.registerProvider(faux.provider);
 let ctx;const observe=()=>{if(ctx)writeFileSync(process.env.FIXTURE_STATE,JSON.stringify({session:ctx.sessionManager.getSessionId(),file:ctx.sessionManager.getSessionFile(),draft:ctx.ui.getEditorText(),idle:ctx.isIdle(),calls:faux.state.callCount}));};
 pi.on('session_start',(_e,c)=>{ctx=c;log('session',{id:c.sessionManager.getSessionId()});observe();});
 pi.on('session_switch',(_e,c)=>{ctx=c;log('switch',{id:c.sessionManager.getSessionId()});observe();});
 pi.on('agent_settled',e=>log('settled',{aborted:e.aborted}));
 pi.on('ui_prompt_start',()=>log('prompt_start'));pi.on('ui_prompt_end',()=>log('prompt_end'));
 const timer=setInterval(observe,50);timer.unref();pi.on('session_shutdown',()=>clearInterval(timer));
 pi.registerCommand('fixture-confirm',{handler:async(_args,c)=>{await c.ui.confirm('Fixture permission','Do not deliver mail during this prompt');}});
}
`,{mode:0o600});
 const control={directory:f.directory,brokerUrl:f.brokerUrl,cert:f.certFile,piCli:join(base,'dist/bundle/cli.js'),extension:resolve('extensions/psst.ts'),fixture};
 const file=join(f.directory,'control.json');writeFileSync(file,JSON.stringify(control),{mode:0o600});
 const child=spawn('python3',['scripts/native-acceptance-pty.py',file],{stdio:['ignore','pipe','pipe']});
 let partial='',stderr='',events=[],work=Promise.resolve(),failure,selection,config,credential,bundle;
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
 child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',buffer=>{partial+=buffer;const lines=partial.split('\n');partial=lines.pop();for(const line of lines)if(line)work=work.then(async()=>{
  const event=JSON.parse(line);events.push(event);
  if(event.event==='failure'){failure=Error(event.reason);return;}
  if(event.event==='pending'){assert.equal(f.approval.list().length,1);await f.decide(f.approval.list()[0].id,'approve');}
  if(event.event==='revoke_pending'){
   selection=createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:join(f.directory,'agent')}).snapshot();
   config=readConfig({PI_CODING_AGENT_DIR:join(f.directory,'agent')},selection.connectionFile);
   credential=readFileSync(config.tokenFile,'utf8');bundle=readFileSync(selection.connectionFile,'utf8');
   await f.decide(f.approval.list()[0].id,'revoke');
   writeFileSync(join(f.directory,'revoked'),'done',{mode:0o600});
  }
 }).catch(error=>{failure=error;child.kill();});});
 const [code]=await once(child,'exit');await work;
 if(failure||code!==0){
  // Preserve only synthetic diagnostics, before fixture teardown removes its root.
  const {mkdirSync,copyFileSync,readdirSync}=await import('node:fs');
  const destination=process.env.PI_ACCEPTANCE_DIAGNOSTICS;
  if(destination){mkdirSync(destination,{recursive:true});for(const name of readdirSync(f.directory))if(/(?:terminal\.bin|events\.jsonl|state\.json)$/.test(name))copyFileSync(join(f.directory,name),join(destination,name));}
 }
 assert.ifError(failure);assert.equal(code,0,stderr);
 assert.deepEqual(events.map(e=>e.event),['pending','roundtrip','draft_guard','prompt_guard','abort_guard','resumed_offline','revoke_pending','revoked_guard','complete']);
 assert.equal(f.approval.list().length,1);
 assert.equal(events.find(e=>e.event==='resumed_offline').sameSession,true);
 assert.deepEqual(createConfigPathStore(f.directory,{PI_CODING_AGENT_DIR:join(f.directory,'agent')}).snapshot(),selection);
 assert.equal(readFileSync(config.tokenFile,'utf8'),credential);
 assert.equal(readFileSync(selection.connectionFile,'utf8'),bundle);
 for(const name of ['a','b'])assert.equal(readFileSync(join(f.directory,name+'-terminal.bin'),'utf8').includes(credential.trim()),false);
});
