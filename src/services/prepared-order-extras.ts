import {randomUUID} from 'node:crypto';
import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import type {InboundMessage} from '../types.js';
import {parseExtras} from './order-extras.js';
import {snapshotKitchenLine} from './kitchen-snapshot.js';
import {fullPaymentInstructions,asksPaymentInformation} from './full-payment.js';
import {cop,windowLabel,normalizeText} from '../lib/format.js';
import {checkStock,extrasCatalog,extrasPrompt} from '../../admin-dashboard/src/order-extras.mjs';
import {saleLineLabel} from '../../admin-dashboard/src/crab-labels.mjs';
import {deliveryWindowNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';

// An operator can prepare an unpaid order and explicitly offer these two extras.
// The reply changes only optional packing/drink lines; food, address, capacity,
// delivery fee and already received money are never reconstructed from a draft.
export async function receivePreparedOrderExtras(db:Db,cfg:Config,message:InboundMessage,orderId:string,now=new Date()) {
 const parsed=parseExtras(message.text);
 const plain=normalizeText(message.text).replace(/[.!¡]+$/g,'').trim();
 const decline=parsed.decline;
 const pay=!parsed.mentioned&&asksPaymentInformation(message.text);
 const order=(await db.query<any>(`SELECT o.id,w.starts_at FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1 AND c.phone_e164=$2`,[orderId,message.phone])).rows[0];
 if(!order)return null;
 const close=async(tx:import('../db/index.js').DbClient)=>tx.query("UPDATE conversations SET context_json=context_json-'pendingPaymentExtrasOrderId',updated_at=$3 WHERE phone_e164=$1 AND context_json->>'pendingPaymentExtrasOrderId'=$2",[message.phone,orderId,now.toISOString()]);
 return db.transaction(async tx=>{
  // Use the same lock order as staff confirmation and kitchen reconciliation.
  const run=(await tx.query<any>("SELECT document FROM kitchen_runs WHERE delivery_date=($1::timestamptz AT TIME ZONE 'America/Bogota')::date FOR UPDATE",[order.starts_at])).rows[0];
  const saved=(await tx.query<any>(`SELECT o.*,w.starts_at,w.ends_at FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1 FOR UPDATE OF o`,[orderId])).rows[0];
  const payments=(await tx.query<any>('SELECT * FROM payments WHERE order_id=$1 FOR UPDATE',[orderId])).rows;
  const pending=payments.filter(p=>p.status==='pending'&&p.provider==='manual_transfer');
  if(saved.status!=='awaiting_payment'||!saved.full_payment_required||new Date(saved.payment_expires_at)<=now||pending.length!==1||pending[0]?.amount_cop!==saved.total_cop||payments.some(p=>p.status==='confirmed')||run&&run.document.phase!=='planning'){
   await close(tx);
   return {orderId,body:`El pedido ${saved.public_id} ya cambió de estado. El equipo revisará el pago y cualquier extra antes de modificarlo.`,complete:true};
  }
  const marker=(await tx.query<any>('SELECT context_json FROM conversations WHERE phone_e164=$1',[message.phone])).rows[0]?.context_json.pendingPaymentExtrasOrderId;
  if(marker!==orderId)return null;
  if(/\b(?:cancelar|cancela|cambiar|cambia|cambio|quitar|quita|direccion|viernes|sabado|domingo|picante|suave|medio|recoger|recogida|domiciliario)\b/.test(plain)){
   await close(tx);
   await tx.query("UPDATE conversations SET state='HUMAN_HANDOFF' WHERE phone_e164=$1",[message.phone]);
   return {orderId,body:`El equipo revisará ese cambio de tu pedido ${saved.public_id} antes de indicarte el pago. Por ahora conservamos los datos guardados.`,complete:false};
  }
  const catalog=await extrasCatalog(tx);
  // Questions and an unquantified yes are not authorization to add a purchase.
  if(!decline&&!pay&&(!parsed.items.length||parsed.invalid||parsed.question||/\bno\b/.test(plain)))return {orderId,body:extrasPrompt(catalog),complete:false};
  const totalBefore=saved.total_cop;
  if(!decline&&!pay){
   const additions=[];
   for(const wanted of parsed.items){
    const item=catalog.find(i=>i.slug===wanted.slug);
    if(!item)return {orderId,body:'Ese extra está agotado. Puedes elegir otro o responder NO para continuar al pago.\n'+extrasPrompt(catalog),complete:false};
    const meta=typeof item.metadata_json==='string'?JSON.parse(item.metadata_json):item.metadata_json;
    const snapshot=snapshotKitchenLine({...item,metadata_json:JSON.stringify(meta)},{menuItemId:item.id,quantity:wanted.quantity});
    if(!snapshot||snapshot.product.requiresHeat||!snapshot.ingredients.every((i:any)=>i.unit==='piece'))throw new Error('La receta del extra necesita revisión');
    additions.push({item,quantity:wanted.quantity,snapshot,cost:meta.costing?{...meta.costing,name:item.name,unitPrice:item.price_cop,quantity:wanted.quantity,totalCost:meta.costing.unitCost*wanted.quantity,heatCost:0}:null});
   }
   try{await checkStock(tx,additions.map(l=>({slug:l.item.slug,quantity:l.quantity})),now);}
   catch(error){return {orderId,body:(error as Error).message+' Responde con otra cantidad o NO para continuar al pago.',complete:false};}
   for(const l of additions)await tx.query(`INSERT INTO order_line_items(id,order_id,menu_item_id,item_name_snapshot,quantity,unit_price_cop,line_total_cop,customization_json,kitchen_snapshot_json,costing_snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8::jsonb,$9::jsonb)`,[randomUUID(),orderId,l.item.id,l.item.name,l.quantity,l.item.price_cop,l.item.price_cop*l.quantity,JSON.stringify(l.snapshot),JSON.stringify(l.cost)]);
   const extra=additions.reduce((sum,l)=>sum+l.item.price_cop*l.quantity,0);
   saved.subtotal_cop+=extra;saved.total_cop+=extra;
   await tx.query('UPDATE orders SET subtotal_cop=$2,total_cop=$3,updated_at=$4 WHERE id=$1',[orderId,saved.subtotal_cop,saved.total_cop,now.toISOString()]);
   await tx.query('UPDATE payments SET amount_cop=$2,updated_at=$3 WHERE id=$1',[pending[0].id,saved.total_cop,now.toISOString()]);
  }
  if(decline)await tx.query('UPDATE orders SET extras_declined=TRUE,updated_at=$2 WHERE id=$1',[orderId,now.toISOString()]);
  await close(tx);
  const lines=(await tx.query<any>('SELECT * FROM order_line_items WHERE order_id=$1 ORDER BY id',[orderId])).rows;
  const items=lines.map(l=>`• ${saleLineLabel(l.item_name_snapshot,l.quantity,l.customization_json)}${l.customization_json?.spice?' · '+l.customization_json.spice:''}: ${cop(l.line_total_cop)}`).join('\n');
  const body=`🧾 *Pedido ${saved.public_id} · pendiente de pago completo*\n\n${items}\nDomicilio: ${cop(saved.delivery_fee_cop-saved.delivery_discount_cop)}\n\n*Total a pagar: ${cop(saved.total_cop)} COP*\n📅 ${windowLabel(saved.starts_at,saved.ends_at,cfg.BUSINESS_TIMEZONE)}\n📍 ${saved.delivery_address}\n\n${fullPaymentInstructions(cfg.MANUAL_TRANSFER_INSTRUCTIONS)}\nTransfiere *${cop(saved.total_cop)}* y envíanos el comprobante por este chat. Confirmaremos tu pedido cuando el equipo verifique el pago completo.\nReferencia: ${saved.public_id}\n\n${deliveryWindowNotice(saved.delivery_coverage)}`;
  await tx.query("INSERT INTO webhook_events(id,provider,provider_event_id,payload_json,received_at,processed_at) VALUES($1,'operator',$2,$3::jsonb,$4,$4)",[randomUUID(),'prepared-order-extras:'+message.eventId,JSON.stringify({orderId,phone:message.phone,reply:message.text,totalBefore,totalAfter:saved.total_cop,extrasDeclined:decline}),now.toISOString()]);
  return {orderId,body,complete:true};
 });
}
