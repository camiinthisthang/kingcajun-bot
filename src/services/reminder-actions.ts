import type {DbClient} from '../db/index.js';
import type {InboundMessage} from '../types.js';
import type {MessagingService} from './messaging.js';
import {knownDeliveryContactDetails,needsDeliveryContacts} from './delivery-contacts.js';

export const reminderButtonTemplateName='kc_recordatorio_botones_v1';
export const reminderButtonTemplateText='🦀 *Pedido {{1}}*\n📅 {{2}}\n📍 {{3}}\n\n{{4}}\n\nConfirma los datos o avísanos si cambia la dirección.';
export const reminderButtonTemplateDefinition={name:reminderButtonTemplateName,language:'es_CO',category:'UTILITY',components:[
 {type:'BODY',text:reminderButtonTemplateText,example:{body_text:[['KC-EJEMPLO','viernes 16 de octubre, 7–9 p. m.','Calle de ejemplo, Medellín. Mapa: https://www.google.com/maps/search/?api=1&query=Medellin','Gracias por tu apoyo. 👑']]}},
 {type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'Confirmar'},{type:'QUICK_REPLY',text:'Cambiar dirección'}]}
]};
export const reminderButtons=(id:string)=>[{id:`kc:reminder:confirm:${id}`,title:'Confirmar'},{id:`kc:reminder:address:${id}`,title:'Cambiar dirección'}];

// The button identifies a sent reminder, not a mutable current order or a phone
// supplied by the customer. A forwarded/forged button cannot affect another chat.
export async function resolveReminderAction(db:DbClient,message:InboundMessage){
 if(!message.actionId?.startsWith('kc:reminder:'))return null;
 const match=message.actionId.match(/^kc:reminder:(confirm|address):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
 if(!match)return {error:'No encontré ese recordatorio. Responde al mensaje de tu pedido para ayudarte.'};
 const row=(await db.query<any>(`SELECT m.*,o.public_id,o.status AS order_status,o.delivery_coverage FROM message_outbox m JOIN orders o ON o.id=m.order_id
  JOIN customers c ON c.id=m.customer_id WHERE m.id=$1 AND c.phone_e164=$2 AND m.status='sent' AND m.kind='reminder_24h'`,[match[2],message.phone])).rows[0];
 if(!row)return {error:'No encontré ese recordatorio para tu número. Responde al mensaje de tu pedido para ayudarte.'};
 if(match[1]==='address'&&row.order_status!=='confirmed')return {error:`El pedido ${row.public_id} ya no está activo. Contacta al equipo; esta respuesta no lo reactiva.`};
 if(match[1]==='address'&&!row.location_check_json)return {error:'Tu pedido es para recogida. Escríbenos qué necesitas cambiar y el equipo te ayudará.'};
 return {row,message:{...message,actionId:undefined,text:match[1]==='confirm'?`CONFIRMO ${row.public_id} 24H`:`DIRECCIÓN INCORRECTA ${row.public_id}`,replyToMessageId:row.provider_message_id} as InboundMessage};
}

// A corrected pin also gets actionable buttons, so this flow never asks the
// customer to copy a command after checking a new map link.
export async function reminderReplyButtons(db:DbClient,phone:string,body:string){
 const reference=body.match(/CONFIRMO (KC-[A-Z0-9]+) 24H/i)?.[1];if(!reference)return null;
 const row=(await db.query<any>(`SELECT m.id,m.order_id FROM message_outbox m JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=m.customer_id
  WHERE c.phone_e164=$1 AND o.public_id=$2 AND m.kind='reminder_24h' AND m.status='sent' ORDER BY m.sent_at DESC LIMIT 1`,[phone,reference])).rows[0];
 if(!row)return null;
 return {orderId:row.order_id,buttons:reminderButtons(row.id),body:body.replace(/responde CONFIRMO KC-[A-Z0-9]+ 24H/ig,'toca Confirmar').replace(/Responde CONFIRMO KC-[A-Z0-9]+ 24H/ig,'Toca Confirmar')};
}

// Ask for missing contacts only after the customer has finished confirming the
// reminder and its location. Optional extras can follow once contacts are ready.
export async function reminderNextQuestion(db:DbClient,messaging:MessagingService,phone:string){
 const row=(await db.query<any>(`SELECT m.order_id FROM message_outbox m JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=o.customer_id
  WHERE c.phone_e164=$1 AND m.kind IN ('reminder_24h','reminder_6h') AND m.status='sent' AND m.confirmation_received_at IS NOT NULL
  AND o.status='confirmed' AND m.sent_at>now()-interval '24 hours'
  AND (m.location_check_json IS NULL OR m.location_check_json->>'status'='confirmed') ORDER BY m.sent_at DESC LIMIT 1`,[phone])).rows[0];
 if(!row)return false;
 const details=await knownDeliveryContactDetails(db,phone);
 if(!needsDeliveryContacts({deliveryContactPhones:details.phones,deliverySingleContactAccepted:details.singleAccepted}))return true;
 const requested=(await db.query("SELECT id FROM message_outbox WHERE order_id=$1 AND kind='reminder_contact_request' AND status='sent' AND sent_at>now()-interval '24 hours' LIMIT 1",[row.order_id])).rowCount;
 if(!requested){
  const body=details.singleAccepted?'Envíanos tu único número de contacto.':details.phones.length===1?'Envíanos otro número diferente de contacto. Si solo tienes uno, dínoslo.':'Envíanos dos números de contacto diferentes. Si solo tienes uno, dínoslo.';
  await messaging.sendNow(phone,body,'reminder_contact_request',row.order_id);
 }
 return false;
}
