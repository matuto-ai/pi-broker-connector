import { canStartNativeTurn } from './native-boundary.mjs';
import { BrokerError } from '../vendor/broker/reference/client.mjs';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { findPersistedReceipt } from './native-delivery.mjs';

export const PRESENCE_TYPE = 'psst-transport-notice';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function presenceText(event) {
  if (!uuid(event?.event_id) || !uuid(event.recipient_id) || event.type !== 'recipient_offline'
      || event.presence_state !== 'disconnected' || !Array.isArray(event.messages) || event.messages.length > 100) throw Error('invalid_presence_notice');
  const messages = event.messages.map(message => {
    if (!uuid(message?.message_id) || !['queued','claimed'].includes(message.delivery_state) || typeof message.delivery_uncertain !== 'boolean') throw Error('invalid_presence_notice');
    return {message_id:message.message_id,delivery_state:message.delivery_state,delivery_uncertain:message.delivery_uncertain};
  });
  const timestamps = {};
  for (const key of ['last_heartbeat_at','created_at','observed_at']) {
    if (typeof event[key] !== 'string' || event[key].length > 40 || !Number.isFinite(Date.parse(event[key]))) throw Error('invalid_presence_notice');
    timestamps[key] = new Date(event[key]).toISOString();
  }
  return 'Psst transport notice: recipient remains disconnected with pending delivery. This is not an agent instruction, a reply timeout, or proof that a message was not received. No automatic resend, cancel or close was performed.\n' + JSON.stringify({event_id:event.event_id,recipient_id:event.recipient_id,presence_state:'disconnected',...timestamps,messages,has_more_messages:event.has_more_messages===true});
}

/** Separate transport journal: never changes message delivery/read receipts. */
export class PresenceNotices {
  constructor({session,pi,ctx,allowed=()=>true,canStart=()=>canStartNativeTurn(ctx),diagnostic=()=>{}}) {
    Object.assign(this,{session,pi,ctx,allowed,canStart,diagnostic});
    this.inbox=session.inbox; this.stopped=false;this.running=null;this.controller=new AbortController();
    this.inbox.transaction(()=>this.inbox.db.exec(`CREATE TABLE IF NOT EXISTS pi_presence_notices(
      event_id TEXT PRIMARY KEY, content TEXT NOT NULL, state TEXT NOT NULL,
      injection_id TEXT, session_file TEXT, file_offset INTEGER, created_at INTEGER NOT NULL)`));
  }
  active(){return !this.stopped && this.session.isAlive() && this.session.deliveryAllowed?.()===true && this.allowed();}
  tick(){
    if(this.running)return this.running;
    if(!this.active() || this.session.client?.policy?.presence_events!==true)return Promise.resolve();
    this.running=this.poll().catch(()=>{if(!this.stopped)this.diagnostic('presence_notice_pending');}).finally(()=>{this.running=null;});
    return this.running;
  }
  async stop(){this.stopped=true;this.controller.abort();await this.running;}
  async poll(){
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(3000)]);
    // Reconcile uncertain native effects before fetching anything new.
    for(const row of this.inbox.db.prepare("SELECT * FROM pi_presence_notices WHERE state='presenting'").all()) {
      if(this.ctx.sessionManager.getSessionFile?.()!==row.session_file)continue;
      if(findPersistedReceipt(row.session_file,row.file_offset,{messageId:row.event_id,injectionId:row.injection_id,clientId:this.inbox.identity.client_id,content:row.content,customType:PRESENCE_TYPE})) {
        this.inbox.transaction(()=>this.inbox.db.prepare("UPDATE pi_presence_notices SET state='presented' WHERE event_id=?").run(row.event_id));
      }
    }
    for(const row of this.inbox.db.prepare("SELECT event_id FROM pi_presence_notices WHERE state='presented'").all()) {
      if(!this.active())return;
      try { await this.session.client.acknowledgePresenceEvent(row.event_id,{signal}); }
      catch(error){if(!(error instanceof BrokerError && error.status===404 && error.code==='message_not_found'))throw error;}
      if(!this.active())return;
      this.inbox.transaction(()=>this.inbox.db.prepare("UPDATE pi_presence_notices SET state='acked' WHERE event_id=?").run(row.event_id));
    }
    let cursor, limited=false;const seen=new Set(),events=[];
    do {
      if(!this.active()||signal.aborted)return;
      if(seen.size>=32){limited=true;break;}
      const page=await this.session.client.presenceEvents({limit:10,...cursor?{cursor}:{}},{signal});
      if(!this.active())return;
      if(!Array.isArray(page.events)||page.events.length>10)throw Error('invalid_presence_page');
      for(const event of page.events)events.push({event,content:presenceText(event)});
      limited ||= page.capacity_limited===true;
      cursor=page.next_cursor;
      if(cursor && seen.has(cursor))throw Error('presence_cursor_cycle');
      if(cursor)seen.add(cursor);
    }while(cursor);
    // Only a complete, non-capacity-limited snapshot can retire never-presented
    // notices. Uncertain native effects and known presentation are never pruned.
    if(!limited){
      const current=new Set(events.map(({event})=>event.event_id));
      this.inbox.transaction(()=>{
        for(const row of this.inbox.db.prepare("SELECT event_id FROM pi_presence_notices WHERE state='pending'").all())
          if(!current.has(row.event_id))this.inbox.db.prepare("DELETE FROM pi_presence_notices WHERE event_id=? AND state='pending'").run(row.event_id);
      });
    }
    for(const {event,content} of events) {
        let row=this.inbox.db.prepare('SELECT * FROM pi_presence_notices WHERE event_id=?').get(event.event_id);
        if(!row){
          this.inbox.transaction(()=>{
            // Bound local metadata. Acknowledged events no longer return from the broker.
            this.inbox.db.prepare("DELETE FROM pi_presence_notices WHERE event_id IN (SELECT event_id FROM pi_presence_notices WHERE state='acked' ORDER BY created_at LIMIT MAX(0,(SELECT COUNT(*) FROM pi_presence_notices)-255))").run();
            if(this.inbox.db.prepare('SELECT COUNT(*) AS n FROM pi_presence_notices').get().n>=256)throw Error('presence_capacity');
            this.inbox.db.prepare("INSERT INTO pi_presence_notices(event_id,content,state,created_at) VALUES(?,?,'pending',?)").run(event.event_id,content,Date.now());
          },{growth:Buffer.byteLength(content)+4096});
          row=this.inbox.db.prepare('SELECT * FROM pi_presence_notices WHERE event_id=?').get(event.event_id);
        }
        if(row.state==='pending' && row.content!==content){
          this.inbox.transaction(()=>this.inbox.db.prepare('UPDATE pi_presence_notices SET content=? WHERE event_id=?').run(content,event.event_id),{growth:Buffer.byteLength(content)});row.content=content;
        }
        if(row.state!=='pending'||!this.active()||!this.canStart()||typeof this.pi.sendMessage!=='function')continue;
        const file=this.ctx.sessionManager.getSessionFile?.();if(typeof file!=='string'||!file.startsWith('/'))continue;
        let offset;try{offset=statSync(file).size;}catch{continue;}
        const injectionId=randomUUID();
        this.inbox.transaction(()=>this.inbox.db.prepare("UPDATE pi_presence_notices SET state='presenting',injection_id=?,session_file=?,file_offset=? WHERE event_id=? AND state='pending'").run(injectionId,file,offset,event.event_id));
        // Return, promise settlement, or a throw is not durable native acceptance.
        Promise.resolve(this.pi.sendMessage({customType:PRESENCE_TYPE,content:row.content,display:true,details:{message_id:event.event_id,injection_id:injectionId,client_id:this.inbox.identity.client_id}}, {triggerTurn:true,deliverAs:'followUp'})).catch(()=>{});
        return; // At most one native handoff per cycle.
      }
  }
}
