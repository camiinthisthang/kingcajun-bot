import {paymentPolicy} from '../business-policy.js';
import {normalizeText} from '../lib/format.js';
import {cop} from '../lib/format.js';
import type {DbClient} from '../db/index.js';
import type {Config} from '../config.js';

// Staff-created receipts and retries use the stored payment, never an AI amount.
// Coverage review may remain pending, but must not hide how to pay.
export async function withPendingTransferDetails(db:DbClient,cfg:Config,orderId:string,body:string,now=new Date()){
  const row=(await db.query<any>(`SELECT o.public_id,o.full_payment_required,o.delivery_coverage,p.amount_cop
    FROM orders o JOIN payments p ON p.order_id=o.id
    WHERE o.id=$1 AND o.status='awaiting_payment' AND o.payment_expires_at>$2
      AND p.provider='manual_transfer' AND p.status='pending'`,[orderId,now.toISOString()])).rows;
  if(row.length!==1)return body;
  const payment=row[0],instructions=payment.full_payment_required?fullPaymentInstructions(cfg.MANUAL_TRANSFER_INSTRUCTIONS):cfg.MANUAL_TRANSFER_INSTRUCTIONS;
  if(body.includes(instructions.trim()))return body;
  return body+`\n\n${instructions}\nValor a transferir: ${cop(payment.amount_cop)}\nReferencia del pedido: ${payment.public_id}\nEnvía el comprobante para que el equipo verifique el pago.`+(payment.delivery_coverage?.needsReview?'\nEl equipo revisará la dirección; la confirmación final requiere verificar el pago y la cobertura.':'');
}

// Full-payment reservations have their own policy. Do not also give the model
// the ordinary deposit threshold: it can otherwise reintroduce that policy.
export function checkoutPaymentPolicy(fullPaymentRequired:boolean) {
  return fullPaymentRequired
    ? {currency:'COP',fullPaymentRequired:true,balanceOnDelivery:false,paymentMethod:'full bank transfer verified by staff'}
    : {...paymentPolicy,fullPaymentRequired:false};
}
export const fullPaymentNotice='Para garantizar tu pedido debes pagar el total por transferencia. Lo confirmamos cuando el equipo verifique el pago completo.';
export const advancePaymentReason='Por la alta demanda y para ofrecerte el mejor servicio, los cupos disponibles se reservan con pago completo anticipado por transferencia.';
export const fullPaymentInstructions=(instructions:string)=>instructions.replace(/abono/gi,'pago completo');
export const contradictsFullPayment=(reply:string)=>/\b(?:abono|abonar|abona|anticipo|pago parcial)\b|contra entrega|pagas? al (?:recibir|recoger)|saldo (?:al|para) (?:recibir|recoger)/i.test(reply);
export function asksPaymentInformation(message:string) {
  const text=normalizeText(message);
  if(/\b(?:ya pague|ya transferi|ya hice|ya realice|envie el comprobante)\b/.test(text))return false;
  return /\b(?:debo|toca|hay que|tengo que|cuanto|como|donde|puedo|necesito)\b.*\b(?:pagar|pago|transferir|abonar|abono)\b/.test(text)
    || /\b(?:cuenta|datos (?:del banco|bancarios|para pagar)|abono|pago completo|pagar (?:el )?(?:total|todo)|valor total)\b/.test(text);
}
export function choosesFullPayment(message:string) {
  const text=normalizeText(message).replace(/[¡!.,]+$/g,'').trim();
  if(/[¿?]/.test(message)||/\b(?:no|quizas|despues|si pudiera)\b/.test(text))return false;
  return /^(?:1|pagar el total|pago completo|pagar todo|transferencia)$/.test(text)
    || /^(?:si[, ]+)?(?:quiero|voy a|prefiero|deseo) pagar (?:el )?(?:total|todo|completo)(?: por transferencia)?(?: para (?:reservar|asegurar|garantizar)(?: mi| el)? (?:pedido|cupo))?(?: por favor| porfa)?$/.test(text)
    || /^(?:si[, ]+)?(?:quiero|voy a|prefiero|deseo) pagar para (?:reservar|asegurar|garantizar)(?: mi| el)? (?:pedido|cupo)(?: por favor| porfa)?$/.test(text);
}
