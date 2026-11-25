import {createHash,randomUUID} from 'node:crypto';
import {requireValue} from './kitchen-domain.mjs';

// This path is only called by authenticated business-app CONFIRMADO commands.
// Amounts come from an explicit owner installment or cited payment evidence, never
// from the amount requested in a pending payment row.
export async function recordStaffPayment(tx,orderId,event,evidence,now=new Date()){
 const date=(await tx.query("SELECT (w.starts_at AT TIME ZONE 'America/Bogota')::date::text AS date FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1",[orderId])).rows[0]?.date;
 const run=(await tx.query('SELECT document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[date])).rows[0];
 const order=(await tx.query('SELECT o.*,w.starts_at FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1 FOR UPDATE OF o',[orderId])).rows[0];
 requireValue(order&&['confirmed','awaiting_payment'].includes(order.status),'El pedido no está activo; revisa antes de registrar un pago.',409);
 requireValue(!order.delivery_coverage?.needsReview,'Primero revisa la entrega.',409);
 requireValue(new Date(order.starts_at)>now,'La entrega ya comenzó; registra el cobro desde operaciones.',409);
 const payments=(await tx.query('SELECT * FROM payments WHERE order_id=$1 FOR UPDATE',[orderId])).rows;
 const received=payments.filter(p=>p.status==='confirmed').reduce((sum,p)=>sum+p.amount_cop,0);
 const target=evidence?.totalPaidCop;
 requireValue(Number.isSafeInteger(target)&&target>0,'No se pudo identificar el monto pagado. Envía CONFIRMADO seguido del nuevo abono aún no registrado en COP, por ejemplo CONFIRMADO 50.000.',409);
 requireValue(target>=received,'El total indicado es menor a lo ya registrado. Revisa el pago en operaciones.',409);
 requireValue(target<=order.total_cop,'El monto supera el total del pedido. Revisa si incluye otro pedido o un pago de más.',409);
 if(target===received)return {amountCop:0,totalPaidCop:received,alreadyRecorded:true};
 requireValue(evidence.previousPaidCop===received,'El pago cambió durante la revisión. Revisa el saldo y envía CONFIRMADO de nuevo.',409);
 const priorKeys=payments.filter(p=>p.status==='confirmed').flatMap(p=>p.raw_payload_json?.evidenceKeys??[]);
 requireValue(!(evidence.keys??[]).some(key=>priorKeys.includes(key)),'Ese comprobante ya fue contabilizado. Si llegó otro pago, indica solo ese nuevo abono con CONFIRMADO 50.000.',409);
 const sharedKeys=(evidence.keys??[]).filter(k=>k.startsWith('image:')||k.startsWith('bank:'));
 requireValue(!sharedKeys.length||!(await tx.query("SELECT 1 FROM payments WHERE order_id<>$1 AND status='confirmed' AND raw_payload_json->'evidenceKeys' ?| $2::text[] LIMIT 1",[orderId,sharedKeys])).rowCount,'Ese comprobante ya aparece en otro pedido. Revisa antes de contabilizarlo nuevamente.',409);
 if(order.status==='awaiting_payment'){
  requireValue(!run||run.document.phase==='planning','La cocina ya inició; revisa antes de añadir este pedido.',409);
  // A late verified payment for an existing reservation is recorded; it never
  // recreates a cancelled order or allocates a new delivery slot.
 }
 const delta=target-received,iso=now.toISOString();
 const ref='WA-CONFIRM:'+createHash('sha256').update(event.eventId).digest('hex');
 const metadata={source:'staff_payment_evidence',staffEventId:event.eventId,reviewedBy:'WhatsApp Business · CONFIRMADO',previousPaidCop:received,totalPaidCop:target,evidenceKeys:evidence.keys??[],evidenceIds:evidence.evidenceIds??[],evidenceSummary:evidence.summary??'',basis:evidence.basis,evidenceThrough:event.sentAt,previousPendingAmounts:payments.filter(p=>p.status==='pending').map(p=>({id:p.id,amountCop:p.amount_cop,provider:p.provider}))};
 const pending=payments.filter(p=>p.status==='pending'&&['manual_transfer','cash_on_delivery'].includes(p.provider));
 if(pending.length===1){
  await tx.query("UPDATE payments SET provider='manual_transfer',provider_payment_id=$2,amount_cop=$3,status='confirmed',raw_payload_json=$4::jsonb,confirmed_at=$5,updated_at=$5 WHERE id=$1",[pending[0].id,ref,delta,JSON.stringify(metadata),iso]);
 }else{
  requireValue(!pending.length,'Hay varios cobros pendientes; revisa antes de registrar el pago.',409);
  await tx.query("INSERT INTO payments(id,order_id,provider,provider_payment_id,reference,amount_cop,status,raw_payload_json,confirmed_at,created_at,updated_at) VALUES($1,$2,'manual_transfer',$3,$3,$4,'confirmed',$5::jsonb,$6,$6,$6)",[randomUUID(),orderId,ref,delta,JSON.stringify(metadata),iso]);
 }
 // Outstanding requirements remain pending instead of treating a partial
 // transfer as full payment. COD orders can accept any verified installment.
 const expected=payments.filter(p=>p.provider==='manual_transfer'&&p.status==='pending').reduce((s,p)=>s+p.amount_cop,0);
 const required=order.full_payment_required?order.total_cop:order.status==='awaiting_payment'?received+expected:0;
 const confirmed=order.status==='confirmed'||target>=required;
 await tx.query('UPDATE orders SET status=$2,updated_at=$3 WHERE id=$1',[orderId,confirmed?'confirmed':'awaiting_payment',iso]);
 if(!confirmed){
  await tx.query("INSERT INTO payments(id,order_id,provider,reference,amount_cop,status,created_at,updated_at) VALUES($1,$2,'manual_transfer',$3,$4,'pending',$5,$5)",[randomUUID(),orderId,ref+'-DUE',required-target,iso]);
 }
 if(confirmed)for(const hours of [24,6]){
  const due=new Date(+new Date(order.starts_at)-hours*3600000);
  if(due>now)await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at)
   SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'pending',$6 WHERE NOT EXISTS(SELECT 1 FROM message_outbox WHERE order_id=$2 AND kind=$3)`,[order.customer_id,orderId,`reminder_${hours}h`,`Recordatorio King Cajun: pedido ${order.public_id}.`,due.toISOString(),iso]);
 }
 return {amountCop:delta,totalPaidCop:target,alreadyRecorded:false};
}
