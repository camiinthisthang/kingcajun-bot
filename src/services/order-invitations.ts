import type {DbClient} from '../db/index.js';
import type {InboundMessage} from '../types.js';
import {normalizeText} from '../lib/format.js';
import {createHash} from 'node:crypto';
import {DateTime} from 'luxon';

export type OrderInvitation = {version:1;deliveryZone:'itagui';windowId:string;acceptedEventId?:string;acceptedAt?:string};

// Only a clear answer to an actual sent invitation may bypass the main menu.
export function acceptsOrderInvitation(text:string){
  const value=normalizeText(text).replace(/\bsi{2,}\b/g,'si').replace(/\b(clar|list|perfect|buen)o{2,}\b/g,'$1o').replace(/\bno (?:hay )?problema\b/g,'de acuerdo');
  if(/\b(no|nunca|tampoco|tal vez|quizas|despues|pudiera|lo pensare|cuando pueda)\b/.test(value))return false;
  // A conditional "si" or an availability question is not an affirmative reply.
  if(/\bsi (?:pago|puedo|hay|tienen|tuviera|pudiera|fuera|llega|llegan|alcanzo|me pagan)\b/.test(value))return false;
  return /\b(si|claro|dale|de una|listo|lista|perfecto|perfecta|ok|okay|oki|okis|yes|sip|sisas|super|vale|acepto|obvio|de acuerdo|por supuesto|esta bien|suena bien|me sirve|me parece bien|me interesa|me encantaria|cuenta conmigo|anotame|apuntame|separame|reservame|hagamos el pedido|vamos con el pedido)\b/.test(value)
    || /\b(?:quiero|queremos|quisiera|deseo|me gustaria) (?:reservar|pedir|hacer (?:mi|el|un) pedido|un cupo|uno|dos|\d+|un combo|el combo)\b/.test(value)
    || /[👍👌✅🙌]/u.test(text);
}

type PendingInvitation={id:string;sent_at:string;provider_message_id:string;customer_id:string;body:string;order_invitation_json:OrderInvitation;source?:'staff'};
const invitationId=(eventId:string)=>{const h=createHash('sha256').update('manual-order-invitation:'+eventId).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};

// The owner also sends the approved outreach from the Business app. Recognize
// that sent echo, not customer text, and bind its explicit date/time to a route.
async function manualOrderInvitation(db:DbClient,phone:string):Promise<PendingInvitation|null>{
  const staff=(await db.query<any>(`SELECT e.*,c.id AS customer_id FROM whatsapp_staff_events e JOIN customers c ON c.phone_e164=e.customer_phone
    WHERE e.customer_phone=$1 AND e.outcome NOT IN ('ignored','needs_review') ORDER BY e.sent_at DESC LIMIT 1`,[phone])).rows[0];
  if(!staff)return null;
  const text=normalizeText(staff.body);
  if(!/\bitagui\b/.test(text)||!(/\babrimos\b/.test(text)&&/\bcupos?\b/.test(text))||!/\btransferencia\b/.test(text)
    ||!(/\bpago completo\b/.test(text)||/\bel total por adelantado\b/.test(text))||!/\b(?:te gustaria|quieres) reservar\b/.test(text))return null;
  const date=text.match(/\bsabado (\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?: de (20\d{2}))?\b/);
  if(!date||!/\b(?:de|entre) 7 (?:a|y) 9 p m\b/.test(text))return null;
  const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const windows=(await db.query<any>(`SELECT w.id,w.starts_at,w.ends_at FROM delivery_zone_allowances a JOIN delivery_windows w ON w.id=a.delivery_window_id
    WHERE a.zone='itagui' AND w.starts_at>$1::timestamptz AND w.starts_at<$1::timestamptz+interval '32 days'`,[staff.sent_at])).rows.filter(w=>{
      const start=DateTime.fromISO(w.starts_at,{zone:'utc'}).setZone('America/Bogota'),end=DateTime.fromISO(w.ends_at,{zone:'utc'}).setZone('America/Bogota');
      return start.weekday===6&&start.day===Number(date[1])&&start.month===months.indexOf(date[2]!)+1&&(!date[3]||start.year===Number(date[3]))&&start.hour===19&&start.minute===0&&end.hour===21&&end.minute===0;
    });
  if(windows.length!==1)return null;
  const id=invitationId(staff.event_id);
  const saved=(await db.query<any>('SELECT * FROM message_outbox WHERE id=$1',[id])).rows[0];
  if(saved)return saved.status==='sent'&&!saved.order_invitation_json?.acceptedEventId?{...saved,customer_id:staff.customer_id}:null;
  return {id,sent_at:staff.sent_at,provider_message_id:staff.event_id,customer_id:staff.customer_id,body:staff.body,source:'staff',order_invitation_json:{version:1,deliveryZone:'itagui',windowId:windows[0].id}};
}

export async function pendingOrderInvitation(db:DbClient,message:InboundMessage){
  if(!acceptsOrderInvitation(message.text))return null;
  let row=(await db.query<PendingInvitation>(`SELECT m.id,m.sent_at,m.provider_message_id,m.body,m.order_invitation_json,c.id AS customer_id
    FROM message_outbox m JOIN customers c ON c.id=m.customer_id
    WHERE c.phone_e164=$1 AND m.kind='order_invitation' AND m.status='sent'
      AND m.order_invitation_json->>'version'='1'
      AND m.order_invitation_json->>'deliveryZone'='itagui'
      AND m.order_invitation_json->>'acceptedEventId' IS NULL
    ORDER BY m.sent_at DESC LIMIT 1`,[message.phone])).rows[0];
  const manual=await manualOrderInvitation(db,message.phone);
  if(manual&&(!row||new Date(manual.sent_at)>new Date(row.sent_at)))row=manual;
  if(!row)return null;
  if(message.replyToMessageId){if(message.replyToMessageId!==row.provider_message_id)return null;}
  else if((await db.query(`SELECT 1 FROM message_outbox WHERE customer_id=$1 AND status='sent' AND sent_at>$2 AND id<>$3
      UNION ALL SELECT 1 FROM whatsapp_staff_events WHERE customer_phone=$4 AND sent_at>$2 LIMIT 1`,[row.customer_id,row.sent_at,row.id,message.phone])).rowCount)return null;
  // A newer human intervention wins, even if the customer quotes the invitation.
  const control=(await db.query<any>('SELECT * FROM whatsapp_chat_controls WHERE customer_phone=$1',[message.phone])).rows[0];
  if(control&&(control.manual_paused_at||new Date(control.paused_until)>new Date())&&control.updated_by!==row.provider_message_id&&new Date(control.updated_at)>new Date(row.sent_at))return null;
  return row;
}

export async function recordManualInvitation(tx:DbClient,invitation:PendingInvitation){
  if(invitation.source!=='staff')return;
  await tx.query(`INSERT INTO message_outbox(id,customer_id,kind,body,due_at,status,created_at,sent_at,provider_message_id,order_invitation_json)
    VALUES($1,$2,'order_invitation',$3,$4,'sent',$4,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING`,
    [invitation.id,invitation.customer_id,invitation.body,invitation.sent_at,invitation.provider_message_id,JSON.stringify(invitation.order_invitation_json)]);
}
