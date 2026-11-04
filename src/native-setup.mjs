import {createConfigPathStore} from './config-path.mjs';
import {storageLayout} from './storage.mjs';
import {LocalError} from '../vendor/broker/reference/errors.mjs';
export function brokerOrigin(value) {
 let u;try{u=new URL(value);}catch{throw new LocalError('invalid_configuration');}
 if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value)||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new LocalError('invalid_configuration');
 return u.origin;
}
export function nativeBrokerSettings(env=process.env) {
 const store=createConfigPathStore(undefined,env);
 return {read(){const url=env.PSST_BROKER_URL||store.snapshot().brokerUrl||store.readPending()?.brokerUrl;return url?brokerOrigin(url):null;}};
}
// Selected approval is historical evidence, never proof of current server access.
// Include the file for selections predating approval metadata.
export function isSelectedApproval(selection, brokerUrl, requestId, connectionFile) {
 return selection?.brokerUrl===brokerUrl&&(
  (requestId&&selection.approvalRequestId===requestId)||
  (connectionFile&&selection.connectionFile===connectionFile));
}
// Called only from an explicit native command, never session_start/auth recovery.
export async function nativeSetup(ctx,{env=process.env,settings=nativeBrokerSettings(env),approvalClient,resumeRequest,selection,reauthorize=false,beforeBegin=()=>{},stillCurrent=()=>true,onPhase=()=>{}}={}) {
 if(!ctx?.hasUI)throw new LocalError('native_input_unavailable');
 onPhase('url_input');
 const configured=selection?.brokerUrl||settings.read();
 const entered=reauthorize&&configured?configured:await ctx.ui.input('Psst broker HTTPS URL',configured||'https://');
 if(entered===undefined||!stillCurrent())return null;
 onPhase('url_validation');
 const brokerUrl=brokerOrigin(entered);
 if(env.PSST_BROKER_URL&&brokerOrigin(env.PSST_BROKER_URL)!==brokerUrl)throw new LocalError('broker_origin_mismatch');
 const options={brokerUrl,directory:storageLayout(env).installationDirectory,clientType:'pi'};
 onPhase('approval_state_read');
 const previous=await approvalClient.readApprovalState(options);
 if(!stillCurrent())return null;
 const resumeApproved=resumeRequest?.brokerUrl===brokerUrl&&resumeRequest.requestId===previous?.requestId&&previous?.state==='approved'&&!isSelectedApproval(selection,brokerUrl,previous.requestId,previous.connectionFile);
 const replace=previous&&previous.state!=='pending'&&!resumeApproved;
 if(replace||(reauthorize&&!previous)){
  if(!await ctx.ui.confirm('Request replacement authorization?', `Target: ${brokerUrl}. This creates a new approval request and replaces the selected installation authorization only after administrator approval and successful connection. It does not revoke the old credential; manual revocation in Psst admin is a separate human action. Previous credentials and unread messages are preserved, but previous access may no longer work.`)||!stillCurrent())return null;
  if(replace)options.replaceRequestId=previous.requestId;
 }
 onPhase('selection_write');await beforeBegin(options);
 if(!stillCurrent())return null;
 onPhase('enrollment_request');const result=await approvalClient.beginApproval(options);
 if(!stillCurrent())return null;
 return {...result,brokerUrl,options};
}
