import {randomUUID} from 'node:crypto';
import {checkStock,extrasCatalog,extrasPrompt} from '../../admin-dashboard/src/order-extras.mjs';
import {snapshotKitchenLine} from './kitchen-snapshot.js';
import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import type {InboundMessage} from '../types.js';
import {cop} from '../lib/format.js';

export function parseExtras(text:string){
 const value=text.trim().toLocaleLowerCase('es-CO').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').replace(/\b(?:un|uno|una)\b/g,'1').replace(/\bdos\b/g,'2').replace(/\btres\b/g,'3').replace(/\bcuatro\b/g,'4').replace(/\bcinco\b/g,'5').replace(/\bseis\b/g,'6');
 // Read a complete refusal, allowing ordinary punctuation and courtesy. A
 // message that rejects one item but requests another is not a blanket decline.
 const answer=value.replace(/\bkc-[a-z0-9]+\b/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
 const decline=/^(?:(?:muchas )?gracias(?: pero)? )?(?:no(?: (?:por ahora|por el momento))?|por ahora no|sin (?:extras|nada mas)|no (?:quiero|deseo|necesito) (?:extras|nada mas|ninguno|ninguna)|(?:no )?asi esta(?: bien| perfecto)?|esta bien asi|dejalo asi|nada mas|solo (?:el )?pedido|ninguno|ninguna)(?: (?:muchas )?gracias)?$/.test(answer);
 const items:Array<{slug:string;quantity:number}>=[];
 const patterns:[string,string][]=[['kit_opcional','(?:kits?|guantes|baberos?|manteles?)'],['drink_6','(?:cocas?|coca[ -]?colas?|cokes?)']];
 let mentioned=false,invalid=false;
 for(const [slug,noun] of patterns){
  if(!new RegExp(`\\b${noun}\\b`).test(value))continue;mentioned=true;
  const match=value.match(new RegExp(`(?:^|\\s)(-?\\d+(?:[.,]\\d+)?)\\s*(?:de\\s+)?${noun}\\b`))??value.match(new RegExp(`\\b${noun}\\s+(?:para\\s+)?(-?\\d+(?:[.,]\\d+)?)(?!\\d|\\s*ml)`));
  const quantity=match?Number(match[1]!.replace(',','.')):NaN;
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>99)invalid=true;else items.push({slug,quantity});
 }
 return {items,mentioned,invalid,question:/[?¿]|\b(cuanto|cuesta|precio|vale|podria|si pidiera)\b/.test(value),decline,cancel:/^cancelar extras\b/.test(value)};
}

function instructions(cfg:Config,quote:any,publicId:string){
 const bank=cfg.MANUAL_TRANSFER_INSTRUCTIONS.replace(/(?:Cuenta para pagar )?abono/gi,'Pago completo').replace(/para confirmar tu pedido/gi,'para confirmar estos extras');
 const deadline=new Intl.DateTimeFormat('es-CO',{timeZone:cfg.BUSINESS_TIMEZONE,weekday:'long',hour:'numeric',minute:'2-digit'}).format(new Date(quote.expires_at));
 return `🧾 *Extras para ${publicId} · pendientes de pago*\n${quote.lines.map((l:any)=>`• ${l.quantity}× ${l.name}: ${cop(l.totalCop)}`).join('\n')}\n*Total adicional: ${cop(quote.total_cop)}*\nSin otro cobro de domicilio.\n\n${bank}\nTransfiere *${cop(quote.total_cop)}* y envía el comprobante antes de ${deadline}.\nReferencia: ${quote.reference}\nEl equipo debe verificar el pago completo para agregarlos. Tu pedido original sigue confirmado. Para descartarlos, escribe CANCELAR EXTRAS ${publicId}.`;
}

// This narrow flow never changes food, delivery date/address, or confirms money
// from a customer's assertion or uploaded receipt.
export async function receiveOrderExtras(db:Db,cfg:Config,message:InboundMessage,now=new Date()):Promise<{body:string;orderId:string}|null>{
 const parsed=parseExtras(message.text),explicit=/\bextras\b/i.test(message.text);
 const paymentQuestion=/\b(?:comprobante|transferencia|transferir|pague|pago|cuenta|banco)\b/i.test(message.text.normalize('NFD').replace(/[\u0300-\u036f]/g,''));
 const pendingPaymentOnly=!parsed.mentioned&&!explicit&&!parsed.decline;
 if(pendingPaymentOnly&&!paymentQuestion)return null;
 const reference=message.text.match(/KC-[A-Z0-9]+/i)?.[0]?.toUpperCase();
 const candidates=(await db.query<any>(`SELECT o.*,w.starts_at FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE c.phone_e164=$1 AND o.status='confirmed' AND w.starts_at>$2 AND ($3::text IS NULL OR o.public_id=$3) AND ($4=FALSE OR EXISTS(SELECT 1 FROM order_extras e WHERE e.order_id=o.id AND e.status='pending' AND e.expires_at>$2))`,[message.phone,now.toISOString(),reference??null,pendingPaymentOnly])).rows;
 if(!candidates.length)return null;
 if(candidates.length!==1)return {body:'Indica la referencia KC-… del pedido al que quieres agregar los extras.',orderId:candidates[0]!.id};
 const order=candidates[0]!;
 // A bare NO is only an answer to a recent extras offer, never a cancellation.
 if(parsed.decline&&!explicit&&!parsed.mentioned){const offer=await db.query("SELECT id FROM message_outbox WHERE order_id=$1 AND status='sent' AND body ILIKE '%extras%' AND sent_at>$2",[order.id,new Date(+now-24*3600000).toISOString()]);if(!offer.rowCount)return null;}
 return db.transaction(async tx=>{
  const run=(await tx.query<any>("SELECT document FROM kitchen_runs WHERE delivery_date=($1::timestamptz AT TIME ZONE 'America/Bogota')::date FOR UPDATE",[order.starts_at])).rows[0];
  const saved=(await tx.query<any>('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
  if(saved.status!=='confirmed')return {body:'El pedido cambió de estado. El equipo debe revisarlo antes de agregar extras.',orderId:order.id};
  await tx.query("UPDATE order_extras SET status='expired' WHERE order_id=$1 AND status='pending' AND expires_at<=$2",[order.id,now.toISOString()]);
  const pending=(await tx.query<any>("SELECT * FROM order_extras WHERE order_id=$1 AND status='pending' FOR UPDATE",[order.id])).rows[0];
  if(parsed.cancel){
   if(pending)await tx.query("UPDATE order_extras SET status='cancelled' WHERE id=$1",[pending.id]);
   return {body:`Descartamos los extras pendientes. Tu pedido ${order.public_id} sigue confirmado. Si ya transferiste por esos extras, avísanos para que el equipo revise el pago.`,orderId:order.id};
  }
  if(parsed.decline){await tx.query('UPDATE orders SET extras_declined=TRUE WHERE id=$1',[order.id]);return {body:pending?'No te volveremos a ofrecer extras. La solicitud de extras que ya hiciste sigue pendiente; para descartarla escribe CANCELAR EXTRAS '+order.public_id+'.':`Listo, sin extras. Tu pedido ${order.public_id} se conserva.`,orderId:order.id};}
  if(pending)return {body:instructions(cfg,pending,order.public_id),orderId:order.id};
  if(+new Date(order.starts_at)-3600000<=+now||run?.document.phase==='complete')return {body:'Ya cerró el plazo para agregar extras a esta entrega. Tu pedido original se conserva.',orderId:order.id};
  const catalog=await extrasCatalog(tx,null,now);
  if(!catalog.length)return {body:'Por ahora no quedan extras disponibles. Tu pedido original se conserva.',orderId:order.id};
  if(!parsed.items.length||parsed.invalid||parsed.question)return {body:extrasPrompt(catalog,order.public_id),orderId:order.id};
  const previous=(await tx.query<any>('SELECT * FROM order_extras WHERE request_event_id=$1',[message.eventId])).rows[0];
  if(previous)return {body:previous.status==='pending'?instructions(cfg,previous,order.public_id):`Esta solicitud de extras ya fue ${previous.status==='confirmed'?'confirmada':'cerrada'}.`,orderId:order.id};
  const lines=[];
  for(const wanted of parsed.items){
   const item=catalog.find(i=>i.slug===wanted.slug);if(!item)return {body:'Uno de esos extras está agotado. '+extrasPrompt(catalog,order.public_id),orderId:order.id};
   const meta=typeof item.metadata_json==='string'?JSON.parse(item.metadata_json):item.metadata_json;
   const snap=snapshotKitchenLine({...item,metadata_json:JSON.stringify(meta)},{menuItemId:item.id,quantity:wanted.quantity});
   if(!snap||snap.product.requiresHeat||!snap.ingredients.every((i:any)=>i.unit==='piece'))throw new Error('La receta de empaque del extra necesita revisión');
   lines.push({menuItemId:item.id,slug:item.slug,name:item.name,quantity:wanted.quantity,priceCop:item.price_cop,totalCop:item.price_cop*wanted.quantity,kitchenSnapshot:snap,costingSnapshot:meta.costing?{...meta.costing,name:item.name,unitPrice:item.price_cop,quantity:wanted.quantity,totalCost:meta.costing.unitCost*wanted.quantity,heatCost:0}:null});
  }
  try{await checkStock(tx,lines,now);}catch(error){return {body:(error as Error).message,orderId:order.id};}
  const quote={id:randomUUID(),reference:'EX-'+randomUUID().slice(0,8).toUpperCase(),lines,total_cop:lines.reduce((s,l)=>s+l.totalCop,0),expires_at:new Date(+new Date(order.starts_at)-3600000).toISOString()};
  await tx.query(`INSERT INTO order_extras(id,reference,order_id,request_event_id,lines,total_cop,status,expires_at,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,'pending',$7,$8)`,[quote.id,quote.reference,order.id,message.eventId,JSON.stringify(lines),quote.total_cop,quote.expires_at,now.toISOString()]);
  return {body:instructions(cfg,quote,order.public_id),orderId:order.id};
 });
}

// If the promotional template is still pending/rejected, the ordinary reminder
// goes out normally. Its customer's reply opens the chat for this optional offer.
export async function reminderReplyExtrasOffer(db:Db,messaging:import('./messaging.js').MessagingService,phone:string,now=new Date()){
 const reminder=(await db.query<any>(`SELECT m.id,m.order_id,o.public_id FROM message_outbox m JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 AND m.kind IN ('reminder_24h','reminder_6h') AND m.status='sent' AND m.extras_offered=FALSE AND m.sent_at>$2 ORDER BY m.sent_at DESC LIMIT 1`,[phone,new Date(+now-24*3600000).toISOString()])).rows[0];
 if(!reminder)return;
 const {reminderExtras}=await import('../../admin-dashboard/src/order-extras.mjs');
 const items=await reminderExtras(db,reminder.order_id,now);if(!items.length)return;
 const sent=await messaging.sendNow(phone,extrasPrompt(items,reminder.public_id),'extras_offer',reminder.order_id);
 if(!('suppressed' in sent))await db.query("UPDATE message_outbox SET extras_offered=TRUE WHERE order_id=$1 AND kind IN ('reminder_24h','reminder_6h') AND status='sent'",[reminder.order_id]);
}
