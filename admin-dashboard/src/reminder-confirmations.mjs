import {confirmReminderLocation} from './location-confirmation.mjs';
import {randomUUID} from 'node:crypto';
export const reminderHours=[24,6];
export const replyWindowHours=12;
export async function migrateReminderConfirmations(db){
 await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS reminder_confirmation_required BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS confirmation_required BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS delivery_confirmed_at TIMESTAMPTZ;
 ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS confirmation_deadline_at TIMESTAMPTZ;
 ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS confirmation_received_at TIMESTAMPTZ;
 ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS reminder_parent_id UUID REFERENCES message_outbox(id);
 CREATE UNIQUE INDEX IF NOT EXISTS one_confirmation_followup ON message_outbox(reminder_parent_id) WHERE kind='reminder_followup_12h';
 CREATE TABLE IF NOT EXISTS whatsapp_delivery_receipts(provider_message_id TEXT PRIMARY KEY,delivered_at TIMESTAMPTZ NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS one_reminder_cancellation_notice ON message_outbox(order_id) WHERE kind='reminder_cancellation';`);
 await db.exec(`UPDATE message_outbox m SET delivery_confirmed_at=COALESCE(m.delivery_confirmed_at,r.delivered_at),
  confirmation_deadline_at=GREATEST(m.confirmation_deadline_at,COALESCE(m.delivery_confirmed_at,r.delivered_at)+interval '12 hours')
  FROM orders o,delivery_windows w,whatsapp_delivery_receipts r WHERE o.id=m.order_id AND w.id=o.delivery_window_id
  AND r.provider_message_id=m.provider_message_id AND o.status='confirmed' AND w.starts_at>now()
  AND m.kind IN ('reminder_24h','reminder_6h') AND m.status='sent';
  UPDATE message_outbox SET status='cancelled' WHERE kind='reminder_cancellation' AND status IN ('pending','failed');`);

}
export function reminderPolicyNotice(startsAt,now=new Date(),confirmationRequired=true){
 const hours=reminderHours.filter(h=>+new Date(startsAt)-h*3600000>+now);
 if(!hours.length)return confirmationRequired?'Por la cercanía de la entrega, este pedido no requiere confirmaciones por recordatorio.':'';
 const timing=hours.map(h=>`${h} horas`).join(' y ');
 if(!confirmationRequired)return `⏰ Te enviaremos ${hours.length===2?'recordatorios':'un recordatorio'} ${timing} antes de la entrega.`;
 return `⏰ Te escribiremos ${timing} antes de la entrega para confirmar.${hours.includes(24)?' Si no recibimos tu respuesta, te enviaremos otro recordatorio 12 horas después.':''}`;
}
export async function recordReminderDelivery(db,providerId,deliveredAt){
 const at=new Date(deliveredAt);if(!providerId||!Number.isFinite(+at))return;
 await db.query(`INSERT INTO whatsapp_delivery_receipts(provider_message_id,delivered_at) VALUES($1,$2) ON CONFLICT DO NOTHING`,[providerId,at.toISOString()]);
 await db.query(`UPDATE message_outbox m SET delivery_confirmed_at=r.delivered_at,confirmation_deadline_at=r.delivered_at+interval '12 hours'
 FROM whatsapp_delivery_receipts r WHERE m.provider_message_id=r.provider_message_id AND r.provider_message_id=$1 AND m.kind IN ('reminder_24h','reminder_6h') AND m.delivery_confirmed_at IS NULL`,[providerId]);
}
/** @param {any} db @param {{phone:string,text:string,replyToMessageId?:string}} message */
export async function confirmReminder(db,{phone,text,replyToMessageId=undefined},now=new Date(),allowBare=true){
 const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
 const explicit=normalized.match(/^CONFIRMO\s+(KC-[A-Z0-9]+)\s+(24|6)H[.!]?$/);
 const bare=/^(SI|SI CONFIRMO|CONFIRMO|CONFIRMADO|CONFIRMAR|DIRECCION CORRECTA|UBICACION CORRECTA|SI ESTA BIEN|SI ES CORRECTA)[.!]?$/.test(normalized);
 if(!explicit&&!(bare&&(allowBare||replyToMessageId)))return null;
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT m.*,o.status AS order_status,o.public_id,w.starts_at FROM message_outbox m
   JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
   WHERE c.phone_e164=$1 AND m.kind IN ('reminder_24h','reminder_6h') AND m.status='sent'
   AND ($2::text IS NULL OR o.public_id=$2) AND ($3::text IS NULL OR m.kind=$3)
   AND ($4::text IS NULL OR m.provider_message_id=$4)
   AND ($5=TRUE OR ((m.confirmation_received_at IS NULL OR m.location_check_json->>'status' IN ('needs_address','needs_pin','needs_barrio','pending')) AND o.status='confirmed' AND w.starts_at>$6))
   ORDER BY m.due_at DESC`,[phone,explicit?.[1]??null,explicit?`reminder_${explicit[2]}h`:null,replyToMessageId??null,!!(explicit||replyToMessageId),now.toISOString()])).rows;
  if(!rows.length)return explicit?'No encontré ese recordatorio para tu número. Revisa la referencia del mensaje.':null;
  if(rows.length>1)return 'Tienes varios recordatorios. Responde a cada mensaje con el texto CONFIRMO y la referencia y hora que aparecen allí.';
  // Every path locks the order before its reminder, including the expiry worker.
  const candidate=rows[0];
  const order=(await tx.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE',[candidate.order_id])).rows[0];
  const fresh=(await tx.query('SELECT * FROM message_outbox WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
  const row={...candidate,...fresh,order_status:order.status};
  if(row.order_status!=='confirmed')return `El pedido ${row.public_id} ya no está activo. Contacta al equipo; esta respuesta no lo reactiva.`;
  if(+new Date(row.starts_at)<=+now)return `El plazo de este recordatorio para ${row.public_id} terminó. Contacta al equipo; no puedo reactivarlo con esta respuesta.`;
  const location=await confirmReminderLocation(tx,row,now);
  if(location?.error)return location.error;
  if(row.confirmation_received_at)return `${location?.confirmed?"✅ Ubicación confirmada. ":""}Ya recibimos tu confirmación de este recordatorio para ${row.public_id}.`;
  await tx.query('UPDATE message_outbox SET confirmation_received_at=$2 WHERE id=$1',[row.id,now.toISOString()]);
  return `✅ ${location?.confirmed?"Ubicación confirmada. ":""}Confirmación recibida para ${row.public_id}. ¡Gracias! 👑`;
 });
}
// Kept as a safe compatibility export for older callers. Missing a reminder
// never cancels an order; cancellation is an explicit staff/customer decision.
/** @param {any} _db @param {Date} _now @param {string[] | null} _allowedPhones */
export async function cancelUnconfirmedReminders(_db,_now=new Date(),_allowedPhones=null){return 0;}

/** @param {any} db @param {Date} now @param {string[] | null} allowedPhones */
export async function queueConfirmationFollowups(db,now=new Date(),allowedPhones=null){
 return db.transaction(async tx=>{
  await tx.query(`UPDATE message_outbox f SET status='cancelled' FROM message_outbox m,orders o
   WHERE f.reminder_parent_id=m.id AND o.id=f.order_id AND f.kind='reminder_followup_12h' AND f.status IN ('pending','failed')
   AND (m.confirmation_received_at IS NOT NULL OR o.status<>'confirmed' OR EXISTS(
    SELECT 1 FROM message_outbox next WHERE next.order_id=o.id AND next.kind='reminder_6h'
     AND next.status IN ('pending','sending','sent') AND next.due_at<=$1))`,[now.toISOString()]);
  const candidates=(await tx.query(`SELECT m.id,m.order_id FROM message_outbox m JOIN orders o ON o.id=m.order_id
   JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
   WHERE m.kind='reminder_24h' AND m.status='sent' AND m.confirmation_received_at IS NULL
   AND m.delivery_confirmed_at IS NOT NULL AND m.confirmation_deadline_at<=$1
   AND o.status='confirmed' AND w.starts_at>$1
   AND ($2::text[] IS NULL OR c.phone_e164=ANY($2::text[]))
   AND NOT EXISTS(SELECT 1 FROM message_outbox next WHERE next.order_id=o.id AND next.kind='reminder_6h'
    AND next.status IN ('pending','sending','sent') AND next.due_at<=$1)
   AND NOT EXISTS(SELECT 1 FROM message_outbox f WHERE f.reminder_parent_id=m.id AND f.kind='reminder_followup_12h')
   ORDER BY o.id,m.id LIMIT 50`,[now.toISOString(),allowedPhones])).rows;
  let queued=0;
  for(const candidate of candidates){
   const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[candidate.order_id])).rows[0];
   const m=(await tx.query('SELECT * FROM message_outbox WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
   if(o.status!=='confirmed'||m.status!=='sent'||m.confirmation_received_at||!m.delivery_confirmed_at||+new Date(m.confirmation_deadline_at)>+now)continue;
   const inserted=await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at,reminder_parent_id)
    VALUES($1,$2,$3,'reminder_followup_12h','',$4,'pending',$4,$5) ON CONFLICT DO NOTHING RETURNING id`,[randomUUID(),o.customer_id,o.id,now.toISOString(),m.id]);
   queued+=inserted.rowCount;
  }
  return queued;
 });
}
