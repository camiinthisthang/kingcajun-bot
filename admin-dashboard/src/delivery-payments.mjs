import {randomUUID} from 'node:crypto';
import {requireValue} from './kitchen-domain.mjs';

// Staff records money already received. This endpoint never charges the customer.
export async function recordDeliveryPayment(db, publicId, input, actor) {
  requireValue(input?.verified === true, 'Confirma que recibiste el dinero.');
  requireValue(Number.isSafeInteger(input.amountCop) && input.amountCop > 0, 'Indica el valor recibido en COP.');
  const reference=typeof input.receiptReference==='string'?input.receiptReference.trim():'';
  requireValue(reference.length>=3 && reference.length<=120,'Registra el comprobante o referencia de caja.');
  return db.transaction(async tx=>{
    const order=(await tx.query('SELECT * FROM orders WHERE public_id=$1 FOR UPDATE',[publicId])).rows[0];
    requireValue(order,'Pedido no encontrado.',404);
    requireValue(!order.delivery_coverage?.needsReview,'Revisa y coordina la entrega antes de registrar el cobro.',409);
    requireValue(['confirmed','fulfilled'].includes(order.status),'Solo puedes registrar el cobro de un pedido confirmado o entregado.',409);
    const prior=(await tx.query('SELECT * FROM delivery_payment_reviews WHERE order_id=$1',[order.id])).rows[0];
    if(prior){requireValue(prior.amount_cop===input.amountCop&&prior.receipt_reference===reference,'El cobro ya se registró con otros datos.',409);return {publicId,alreadyRecorded:true};}
    const paid=Number((await tx.query("SELECT COALESCE(SUM(amount_cop),0)::int AS total FROM payments WHERE order_id=$1 AND status='confirmed'",[order.id])).rows[0].total);
    requireValue(order.total_cop-paid===input.amountCop,'El valor debe coincidir con el saldo pendiente.',409);
    requireValue(!(await tx.query('SELECT order_id FROM delivery_payment_reviews WHERE receipt_reference=$1',[reference])).rowCount,'La referencia ya está registrada.',409);
    const now=new Date().toISOString();
    await tx.query('INSERT INTO delivery_payment_reviews(order_id,amount_cop,receipt_reference,reviewed_by,reviewed_at) VALUES($1,$2,$3,$4,$5)',[order.id,input.amountCop,reference,actor,now]);
    const pending=(await tx.query("SELECT id FROM payments WHERE order_id=$1 AND provider='cash_on_delivery' AND status='pending' FOR UPDATE",[order.id])).rows[0];
    if(pending)await tx.query("UPDATE payments SET status='confirmed',amount_cop=$2,confirmed_at=$3,updated_at=$3,raw_payload_json=$4::jsonb WHERE id=$1",[pending.id,input.amountCop,now,JSON.stringify({source:'delivery_collection',receiptReference:reference,reviewedBy:actor})]);
    else await tx.query("INSERT INTO payments(id,order_id,provider,reference,amount_cop,status,confirmed_at,created_at,updated_at,raw_payload_json) VALUES($1,$2,'cash_on_delivery',$3,$4,'confirmed',$5,$5,$5,$6::jsonb)",[randomUUID(),order.id,order.payment_reference+'-BALANCE',input.amountCop,now,JSON.stringify({source:'delivery_collection',receiptReference:reference,reviewedBy:actor})]);
    return {publicId,alreadyRecorded:false};
  });
}
