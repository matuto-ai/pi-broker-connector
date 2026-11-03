import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartNativeTurn, NativeInputBoundary } from '../src/native-boundary.mjs';
const context = () => ({hasUI:true,isIdle:()=>true,hasPendingMessages:()=>false,ui:{getEditorText:()=>''}});
test('safe boundary fails closed for missing, throwing or nonempty editor state',()=>{
 const ctx=context();assert.equal(canStartNativeTurn(ctx),true);
 for(const getEditorText of [undefined,()=>undefined,()=>null,()=> ' ',()=>{throw Error('unavailable');}]) {
  ctx.ui={getEditorText};assert.equal(canStartNativeTurn(ctx),false);
 }
 ctx.hasUI=false;assert.equal(canStartNativeTurn(ctx),true);
 ctx.isIdle=()=>false;assert.equal(canStartNativeTurn(ctx),false);
});
test('public prompt events gate both consumers; only human input clears an abort hold',()=>{
 const events={},holds=[],ctx=context(),boundary=new NativeInputBoundary({on:(event,fn)=>events[event]=fn},()=>({setHumanPaused:value=>holds.push(value)}));
 assert.equal(boundary.allows(ctx),true);
 events.ui_prompt_start({kind:'confirm',title:'private prompt'});assert.equal(boundary.allows(ctx),false);
 // Repeated notifications remain a single outer prompt, matching the native API.
 events.ui_prompt_start({kind:'custom'});events.ui_prompt_end({});assert.equal(boundary.allows(ctx),true);
 events.agent_settled({aborted:false},ctx);assert.deepEqual(holds,[]);
 events.agent_settled({aborted:true},ctx);assert.deepEqual(holds,[true]);
 events.input({source:'extension',text:'yes'},ctx);assert.deepEqual(holds,[true]);
 events.input({source:'interactive',text:'continue'},ctx);events.input({source:'rpc',text:'continue'},ctx);assert.deepEqual(holds,[true,false,false]);
});


test('abort before any connection remains latched for that native conversation only',()=>{
 const events={},boundary=new NativeInputBoundary({on:(event,fn)=>events[event]=fn});
 const a={...context(),sessionManager:{getSessionId:()=> 'a'}},b={...context(),sessionManager:{getSessionId:()=> 'b'}};
 events.agent_settled({aborted:true},a);assert.equal(boundary.allows(a),false);assert.equal(boundary.allows(b),true);
 assert.equal(boundary.resume(a,0),false);assert.equal(boundary.allows(a),false);
 events.input({source:'extension',text:'yes'},a);assert.equal(boundary.allows(a),false);
 events.input({source:'interactive'},a);assert.equal(boundary.allows(a),true);
});
