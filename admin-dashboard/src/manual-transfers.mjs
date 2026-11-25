import {variableWeightNotice} from './crab-labels.mjs';
import {orderConfirmationNotice} from './confirmation-notices.mjs';
import {randomUUID} from 'node:crypto';
import {requireValue} from './kitchen-domain.mjs';
export async function confirmManualTransfer(db, publicId, input, actor, now = new Date()) {
  requireValue(input?.verified === true, 'Confirma que viste el pago en la cuenta bancaria.');
  requireValue(Number.isSafeInteger(input.amountCop) && input.amountCop > 0, 'Indica el valor recibido en COP.');
  const bankReference = typeof input.bankReference === 'string' ? input.bankReference.trim() : '';
  requireValue(bankReference.length >= 3 && bankReference.length <= 120, 'Registra una referencia bancaria para la revisión.');
  return db.transaction(async tx => {
    const date = (await tx.query(`SELECT (w.starts_at AT TIME ZONE 'America/Bogota')::date::text AS date FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.public_id=$1`,[publicId])).rows[0]?.date;
    requireValue(date, 'Pedido no encontrado.', 404);
    // Same lock order as kitchen reconciliation: run first, then source orders.
    const run = (await tx.query('SELECT document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[date])).rows[0];
    const row = (await tx.query(`SELECT o.id, o.status, o.customer_id, o.total_cop, o.full_payment_required, o.delivery_coverage, o.reminder_confirmation_required, o.payment_expires_at, p.id AS payment_id, p.provider, p.amount_cop AS expected_payment_cop, p.status AS payment_status, w.starts_at, w.ends_at
      FROM orders o JOIN payments p ON p.order_id=o.id AND p.provider='manual_transfer' JOIN delivery_windows w ON w.id=o.delivery_window_id
      WHERE o.public_id=$1 FOR UPDATE OF o,p`,[publicId])).rows[0];
    requireValue(!row?.delivery_coverage?.needsReview,'Coordina y revisa la entrega antes de confirmar el pago.',409);
    requireValue(row?.provider === 'manual_transfer', 'Este pedido no usa transferencia manual.');
    requireValue(row.status !== 'cancelled', 'El pedido está cancelado. Revisa el reembolso; no se reactivará.',409);
    const prior=(await tx.query('SELECT * FROM manual_payment_reviews WHERE order_id=$1',[row.id])).rows[0];
    if(prior){requireValue(prior.amount_cop===input.amountCop && prior.bank_reference===bankReference,'El pago ya fue verificado con otros datos.',409);return {publicId,alreadyConfirmed:true};}
    requireValue(row.status==='awaiting_payment' && row.payment_status==='pending','El pedido requiere revisión; no puede confirmarse aquí.',409);
    requireValue(now < new Date(row.payment_expires_at) && now < new Date(new Date(row.starts_at).getTime()-12*3600000),'El plazo de verificación cerró. Revisa el pago y la devolución con el cliente.',409);
    requireValue(!run || run.document.phase==='planning','La cocina ya inició esta jornada; no se añadirán pedidos.',409);
    requireValue(input.amountCop===row.expected_payment_cop,'El valor recibido no coincide con el pago esperado. Resuelve la diferencia antes de confirmar.',409);
    requireValue(!(await tx.query('SELECT order_id FROM manual_payment_reviews WHERE bank_reference=$1',[bankReference])).rowCount,'Esa referencia bancaria ya se usó en otro pedido.',409);
    await tx.query('INSERT INTO manual_payment_reviews (order_id,payment_id,amount_cop,bank_reference,reviewed_by,reviewed_at) VALUES ($1,$2,$3,$4,$5,$6)',[row.id,row.payment_id,input.amountCop,bankReference,actor,now.toISOString()]);
    await tx.query(`UPDATE payments SET status='confirmed',provider_payment_id=$2,confirmed_at=$3,updated_at=$3,raw_payload_json=$4::jsonb WHERE id=$1`,[row.payment_id,bankReference,now.toISOString(),JSON.stringify({source:'staff_verification',reviewedBy:actor})]);
    await tx.query(`UPDATE orders SET status='confirmed',updated_at=$2 WHERE id=$1`,[row.id,now.toISOString()]);
    const weightNotice=variableWeightNotice((await tx.query('SELECT customization_json FROM order_line_items WHERE order_id=$1',[row.id])).rows.map(l=>l.customization_json));
    await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) VALUES($1,$2,$3,'deposit_confirmation',$4,$5,'pending',$5)`,[randomUUID(),row.customer_id,row.id,`✅ Recibimos tu ${row.full_payment_required?'pago completo':'abono'} de $${input.amountCop.toLocaleString('es-CO')}. Tu pedido ${publicId} está confirmado. ${row.full_payment_required?'Total pagado.':`Saldo contra entrega: $${(row.total_cop-input.amountCop).toLocaleString('es-CO')}.`}${weightNotice}\n\n${orderConfirmationNotice(row,now)}`,now.toISOString()]);
    for(const hours of [24,6]){const due=new Date(new Date(row.starts_at).getTime()-hours*3600000);if(due>now)await tx.query(`INSERT INTO message_outbox (id,customer_id,order_id,kind,body,due_at,status,created_at) SELECT $1,$2,$3,$4,$5,$6,'pending',$7 WHERE NOT EXISTS (SELECT 1 FROM message_outbox WHERE order_id=$3 AND kind=$4)`,[randomUUID(),row.customer_id,row.id,`reminder_${hours}h`,`Recordatorio King Cajun: pedido ${publicId}.`,due.toISOString(),now.toISOString()]);}
    return {publicId,alreadyConfirmed:false};
  });
}
