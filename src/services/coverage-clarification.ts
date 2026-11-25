import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import type {InboundMessage} from '../types.js';
import {fullPaymentInstructions,fullPaymentNotice} from './full-payment.js';
import {destinationStatement,literalAddress,coverageSnapshot,locationFromAddress} from './delivery-coverage.js';
import {resolveDeliveryCoverage} from '../../admin-dashboard/src/delivery-coverage.mjs';
import {orderConfirmationNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';
import {cop,normalizeText,windowLabel} from '../lib/format.js';

// A literal clarification can finish the coverage check on the customer's one
// recent order. Never change a paid order, a pickup arrangement or an excluded zone.
export async function clarifyRegisteredCoverage(db:Db,cfg:Config,message:InboundMessage){
 const supplied=destinationStatement(message.text),address=literalAddress(message.text);
 if(!supplied&&!address)return null;
 return db.transaction(async tx=>{
  const rows=(await tx.query<any>(`SELECT o.*,w.starts_at,w.ends_at FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
   WHERE c.phone_e164=$1 AND o.status IN ('confirmed','awaiting_payment') AND w.starts_at>now() ORDER BY o.created_at DESC`,[message.phone])).rows;
  if(rows.length!==1)return null;
  const order=rows[0],old=order.delivery_coverage;
  if(!old?.needsReview||old.status!=='unknown'||['pickup','own_courier'].includes(old.preference)||Date.now()-+new Date(order.created_at)>24*3600000)return null;
  if((await tx.query("SELECT id FROM payments WHERE order_id=$1 AND status='confirmed'",[order.id])).rowCount)return null;
  const previous=locationFromAddress(order.delivery_address);
  const location={municipality:supplied?.municipality??previous.municipality,area:supplied?.area??previous.area};
  const coverage=coverageSnapshot(location);
  if(coverage.status!=='inside')return null;
  let details=address??order.delivery_address;
  for(const place of [location.area,location.municipality])if(place&&!normalizeText(details).includes(normalizeText(place)))details+=`, ${place}`;
  const wrapped:Db={...tx,transaction:work=>work(tx),close:async()=>{}};
  const resolved=await resolveDeliveryCoverage(wrapped,order.public_id,{agreedWithCustomer:true,method:'delivery',details,deliveryFeeCop:order.delivery_fee_cop},'Customer literal coverage clarification · '+message.eventId);
  await tx.query(`UPDATE orders SET delivery_coverage=delivery_coverage || $2::jsonb WHERE id=$1`,[order.id,JSON.stringify(coverage)]);
  const deposit=resolved.depositCop;
  const body=`✅ Ya guardé tu dirección completa dentro de nuestra zona. Pedido ${order.public_id}.\n${windowLabel(order.starts_at,order.ends_at,cfg.BUSINESS_TIMEZONE)}\n${details}\n\nTotal: ${cop(resolved.totalCop)} · domicilio: ${cop(order.delivery_fee_cop-order.delivery_discount_cop)}.${order.full_payment_required?`\n${fullPaymentNotice}\n\n${fullPaymentInstructions(cfg.MANUAL_TRANSFER_INSTRUCTIONS)}\nValor: ${cop(resolved.totalCop)}\nReferencia: ${order.public_id}\nEnvía el comprobante para que el equipo lo verifique.`:deposit?`\nPara reservar, abona ${cop(deposit)}. El saldo de ${cop(resolved.totalCop-deposit)} se paga al recibir.\n\n${cfg.MANUAL_TRANSFER_INSTRUCTIONS}\n\nEnvíanos el comprobante con la referencia ${order.public_id}; el equipo debe verificarlo antes de confirmar el pedido.`:`\nTu pedido está confirmado; pagas al recibir.\n\n${orderConfirmationNotice({...order,delivery_coverage:coverage})}`}`;
  // Replace the short coverage receipt with this complete confirmation once.
  await tx.query("UPDATE message_outbox SET status='cancelled' WHERE order_id=$1 AND kind='order_confirmation' AND status='pending'",[order.id]);
  await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,now(),'pending',now())`,[order.customer_id,order.id,deposit?'reservation_instructions':'order_confirmation',body]);
  return {publicId:order.public_id,coverageResolved:true};
 });
}
