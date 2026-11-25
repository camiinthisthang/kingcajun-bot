import {createHash} from 'node:crypto';
import {parseProjectFiles} from '@trigramco/ontolang';
import {compileModel,executeStory} from '@trigramco/ontolang/runtime';
import {source,revision} from './model.mjs';

export function compileWorkflow(text=source){return {model:compileModel(parseProjectFiles('king-cajun',{'project.onto':text})),revision:createHash('sha256').update(text).digest('hex')};}
export const workflow=compileWorkflow();
export {revision};
export class WorkflowError extends Error {constructor(violations){super('Onto no permite este cambio. '+violations.map(v=>v.rule||v.message||v.kind).join(' · '));this.status=409;this.code='workflow_refused';this.violations=violations;}}
export async function migratePos(db){
  await db.exec(`
    ALTER TABLE dine_in_tickets ALTER COLUMN visit_id DROP NOT NULL;
    ALTER TABLE dine_in_tickets ADD COLUMN IF NOT EXISTS source_order_id UUID UNIQUE REFERENCES orders(id);
    ALTER TABLE dine_in_tickets ADD COLUMN IF NOT EXISTS onto_facts JSONB;
    ALTER TABLE dine_in_tickets ADD COLUMN IF NOT EXISTS onto_revision TEXT;
    ALTER TABLE delivery_windows ADD COLUMN IF NOT EXISTS pos_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS pos_executions(id BIGSERIAL PRIMARY KEY,ticket_id INTEGER REFERENCES dine_in_tickets(id),actor_id TEXT NOT NULL,story TEXT NOT NULL,revision TEXT NOT NULL,input JSONB NOT NULL,before_snapshot JSONB NOT NULL,after_snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS pos_jobs(id UUID PRIMARY KEY,ticket_id INTEGER NOT NULL REFERENCES dine_in_tickets(id),kind TEXT NOT NULL CHECK(kind IN ('print','whatsapp')),event_key TEXT NOT NULL UNIQUE,payload JSONB NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease UUID,next_at TIMESTAMPTZ NOT NULL DEFAULT now(),provider_id TEXT,last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS pos_jobs_pending ON pos_jobs(state,next_at);
    CREATE TABLE IF NOT EXISTS pos_chats(phone TEXT PRIMARY KEY,context JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS pos_checkouts(key TEXT PRIMARY KEY,phone TEXT NOT NULL,response JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS pos_slot_changes(id BIGSERIAL PRIMARY KEY,slot_id UUID NOT NULL REFERENCES delivery_windows(id),actor_id TEXT NOT NULL,detail JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
}

const id=t=>`ticket:${t.id}`;
const facts=t=>t.onto_facts??{reference:String(t.id),channel:t.source_order_id?'delivery':'table',status:t.state,started:!['new','reserved'].includes(t.state),approved:false,confirmed:true,paymentRequired:false,paymentVerified:false};
export async function runTicketStory(tx,t,story,actor,{creating=false,fields={},slotId,compiled=workflow}={}){
  if(!actor?.id||!Array.isArray(actor.roles))throw Object.assign(Error('Inicia sesión con tu usuario del equipo.'),{status:401,code:'unauthorized'});
  const tickets=(await tx.query('SELECT id,state,source_order_id,onto_facts FROM dine_in_tickets ORDER BY id')).rows;
  const slots=(await tx.query('SELECT id,capacity,starts_at FROM delivery_windows WHERE pos_enabled=TRUE')).rows;
  const instances=tickets.filter(row=>!creating||row.id!==t.id).map(row=>({id:id(row),type:'Ticket',fields:facts(row)}));
  for(const slot of slots)instances.push({id:`slot:${slot.id}`,type:'Slot',fields:{name:String(slot.starts_at),capacity:Number(slot.capacity)}});
  // Existing bookings consume capacity too; enabling a window cannot erase them.
  const legacy=(await tx.query(`SELECT o.id,o.delivery_window_id,o.status FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE w.pos_enabled=TRUE AND NOT EXISTS(SELECT 1 FROM dine_in_tickets t WHERE t.source_order_id=o.id) AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>now())`)).rows;
  for(const row of legacy)instances.push({id:`legacy:${row.id}`,type:'Ticket',fields:{reference:row.id,channel:'delivery',status:row.status==='fulfilled'?'served':'reserved',slot:`slot:${row.delivery_window_id}`}});
  instances.push({id:actor.id,type:actor.system?'DeliveryBot':'Person',fields:{name:actor.name||actor.id},...(actor.system?{}:{holdings:actor.roles})});
  // Trusted payment/customer facts come from locked application records, never the browser.
  if(!creating&&Object.keys(fields).length){const current=instances.find(row=>row.id===id(t));current.fields={...current.fields,...fields};}
  const before={instances,now:new Date().toISOString()};
  const input={story,actor:actor.id,...(creating?{mint:id(t),fields}:{object:id(t)}),...(slotId?{participants:{Slot:`slot:${slotId}`}}:{})};
  const result=executeStory(compiled.model,before,input);
  if(!result.committed)throw new WorkflowError(result.violations);
  const updated=result.snapshot.instances.find(row=>row.id===id(t)).fields;
  await tx.query('UPDATE dine_in_tickets SET state=$2,onto_facts=$3::jsonb,onto_revision=$4 WHERE id=$1',[t.id,updated.status,JSON.stringify(updated),compiled.revision]);
  await tx.query('INSERT INTO pos_executions(ticket_id,actor_id,story,revision,input,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',[t.id,actor.id,story,compiled.revision,JSON.stringify(input),JSON.stringify(before),JSON.stringify(result.snapshot)]);
  return updated;
}
export const botActor={id:'service:whatsapp',name:'WhatsApp',roles:[],system:true};
export const stories={cooking:'Cook starts Ticket',ready:'Cook finishes Ticket',served:'Waiter serves Ticket',dispatched:'Waiter dispatches Ticket',cancel_requested:'Waiter requests Ticket',approved:'Manager approves Ticket',cancelled:'Cook cancels Ticket'};
