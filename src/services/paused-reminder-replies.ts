import type {Db} from '../db/index.js';
import type {InboundMessage} from '../types.js';
import type {MessagingService} from './messaging.js';
import {resolveReminderAction,reminderReplyButtons,reminderNextQuestion} from './reminder-actions.js';
import {receiveLocationCorrection} from './location-confirmation.js';
import {receiveReminderContacts,contactNumbers,onlyOneContact} from './delivery-contacts.js';
import {confirmReminder} from '../../admin-dashboard/src/reminder-confirmations.mjs';

// An operator pause silences AI conversation, not the customer's explicit reply
// to an existing-order reminder. Never interpret an unrelated "sí" as consent,
// release the pause, run the ordering assistant, or offer extras on this path.
export async function receivePausedReminderReply(db:Db,messaging:MessagingService,input:InboundMessage){
 // A failed link belongs to the team now. Do not restart the reminder loop,
 // even if the customer presses its old confirmation button again.
 const manualLocation=(await db.query(`SELECT m.id FROM message_outbox m JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=m.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
 WHERE c.phone_e164=$1 AND o.status='confirmed' AND w.starts_at>now() AND m.kind='reminder_24h' AND m.location_check_json->>'status'='manual_review'`,[input.phone])).rowCount>0;
 if(manualLocation)return true;
 let message=input,explicit=false;
 if(message.actionId?.startsWith('kc:reminder:')){
  const resolved=await resolveReminderAction(db,message);
  if(resolved?.error){await messaging.sendNow(message.phone,resolved.error,'reminder_transactional');return true;}
  if(!resolved?.message)return false;
  message=resolved.message;explicit=true;
 }
 if(message.replyToMessageId){
  explicit=explicit||(await db.query(`SELECT m.id FROM message_outbox m JOIN customers c ON c.id=m.customer_id
   WHERE c.phone_e164=$1 AND m.provider_message_id=$2 AND m.status='sent' AND m.kind IN ('reminder_24h','reminder_6h')`,[message.phone,message.replyToMessageId])).rowCount>0;
 }
 explicit=explicit||/^CONFIRMO\s+KC-[A-Z0-9]+\s+(?:24|6)H[.!]?$/i.test(message.text.trim());
 // Approved fallback templates ask for a plain SÍ. Accept that only when a
 // reminder is the latest business question, newer than every manual reply.
 // Quoting its provider ID keeps the normal ownership/ambiguity checks intact.
 if(!explicit&&!message.actionId&&!message.replyToMessageId){
  const answer=message.text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
  if(/^(?:SI|SI CONFIRMO|CONFIRMO|CONFIRMADO|CONFIRMAR|DIRECCION CORRECTA|UBICACION CORRECTA|SI ESTA BIEN|SI ES CORRECTA|CAMBIAR DIRECCION|DIRECCION INCORRECTA)[.!]?$/.test(answer)){
   const latest=(await db.query<any>(`SELECT m.* FROM message_outbox m JOIN customers c ON c.id=m.customer_id
    WHERE c.phone_e164=$1 AND m.status='sent' ORDER BY m.sent_at DESC LIMIT 1`,[message.phone])).rows[0];
   if(latest&&['reminder_24h','reminder_6h','reminder_followup_12h'].includes(latest.kind)&&latest.provider_message_id&&Date.now()-+new Date(latest.sent_at)<24*3600000){
    const manual=(await db.query(`SELECT event_id FROM whatsapp_staff_events WHERE customer_phone=$1 AND sent_at>$2
     AND NOT EXISTS(SELECT 1 FROM message_outbox sent WHERE sent.provider_message_id=whatsapp_staff_events.event_id) LIMIT 1`,[message.phone,latest.sent_at])).rowCount>0;
    if(!manual){
     const parent=latest.reminder_parent_id?(await db.query<any>('SELECT provider_message_id FROM message_outbox WHERE id=$1',[latest.reminder_parent_id])).rows[0]:null;
     message={...message,replyToMessageId:parent?.provider_message_id??latest.provider_message_id};explicit=true;
    }
   }
  }
 }
 const correcting=(await db.query(`SELECT m.id FROM message_outbox m JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=m.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
  WHERE c.phone_e164=$1 AND m.kind='reminder_24h' AND m.status='sent' AND o.status='confirmed' AND w.starts_at>now()
  AND m.location_check_json->>'status' IN ('needs_address','needs_pin','needs_barrio')`,[message.phone])).rowCount>0;
 const contactReply=(contactNumbers(message.text).length||onlyOneContact(message.text))?await receiveReminderContacts(db,message.phone,message.text):null;
 if(!explicit&&!correcting&&!contactReply)return false;
 const locationReply=(explicit||correcting)?await receiveLocationCorrection(db,message,new Date(),false):null;
 const confirmation=!locationReply&&explicit?await confirmReminder(db,message,new Date(),false):null;
 const body=[locationReply,confirmation,contactReply].filter(Boolean).join('\n\n');
 if(!body)return false;
 const buttons=await reminderReplyButtons(db,message.phone,body);
 if(buttons)await messaging.sendButtonsNow(message.phone,buttons.body,buttons.buttons,'reminder_transactional',buttons.orderId);
 else await messaging.sendNow(message.phone,body,'reminder_transactional');
 if(confirmation&&!locationReply)await reminderNextQuestion(db,messaging,message.phone);
 return true;
}
