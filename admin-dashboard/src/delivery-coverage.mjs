import {usesDeliveryCapacity,lockDeliveryCapacity,deliveryCapacityUsed} from './booking-capacity.mjs';
import {orderConfirmationNotice} from './confirmation-notices.mjs';
import {requireValue} from './kitchen-domain.mjs';
import {paymentPolicy} from './payment-policy.mjs';

// Records arrangements the staff has already agreed with the customer. Never
// charges money or silently approves AI coverage guesses. Queues the reminder
// policy receipt when an enrolled order is confirmed.
export async function resolveDeliveryCoverage(db,publicId,input,actor,now=new Date()) {
  requireValue(input?.agreedWithCustomer===true,'Confirma que coordinaste la entrega y el valor con el cliente.');
  requireValue(['delivery','pickup','own_courier'].includes(input.method),'Elige la modalidad acordada.');
  requireValue(typeof input.details==='string'&&input.details.trim().length>=8&&input.details.length<=600,'Registra la dirección o instrucciones acordadas.');
  requireValue(Number.isSafeInteger(input.deliveryFeeCop)&&input.deliveryFeeCop>=0&&input.deliveryFeeCop<=100000,'Indica la tarifa de domicilio acordada en COP.');
  if(input.method!=='delivery')requireValue(input.deliveryFeeCop===0,'La recogida o mensajero propio no lleva tarifa de domicilio de King Cajun.');
  return db.transaction(async tx=>{
    const date=(await tx.query(`SELECT (w.starts_at AT TIME ZONE 'America/Bogota')::date::text AS date,o.delivery_window_id,o.delivery_coverage FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.public_id=$1`,[publicId])).rows[0];
    requireValue(date,'Pedido no encontrado.',404);
    const run=(await tx.query('SELECT document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[date.date])).rows[0];
    const zone=input.method==='delivery'?date.delivery_coverage?.capacityZone??null:null;
    if(zone==='itagui')requireValue(/\bitagui\b/.test(input.details.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()),'Este cupo es exclusivo para Itagüí. Revisa la ruta antes de cambiar el destino.',409);
    const limits=await lockDeliveryCapacity(tx,date.delivery_window_id,zone);
    const order=(await tx.query('SELECT o.*,w.starts_at,w.ends_at FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.public_id=$1 FOR UPDATE OF o',[publicId])).rows[0];
    requireValue(order.delivery_coverage?.needsReview,'La entrega no tiene revisión pendiente.',409);
    requireValue(['confirmed','awaiting_payment'].includes(order.status)&&new Date(order.starts_at)>now,'El pedido ya no admite esta revisión.',409);
    requireValue(!run||run.document.phase==='planning','La cocina ya inició; coordina cualquier cambio directamente.',409);
    if(input.method==='delivery'&&!usesDeliveryCapacity(order)){
      const used=await deliveryCapacityUsed(tx,order.delivery_window_id,limits.date,now.toISOString(),order.id,zone);
      requireValue(used.daily<limits.day&&used.window<limits.window,'No quedan cupos de domicilio en esa franja. Conserva la recogida o acuerda otra franja.',409);
    }
    const payments=(await tx.query('SELECT * FROM payments WHERE order_id=$1 FOR UPDATE',[order.id])).rows;
    const paid=payments.filter(p=>p.status==='confirmed').reduce((n,p)=>n+p.amount_cop,0);
    const discount=order.delivery_discount_cop>0?input.deliveryFeeCop:0;
    const total=order.subtotal_cop+input.deliveryFeeCop-discount;
    requireValue(!paid||total===order.total_cop,'Ya hay dinero recibido. Resuelve primero cualquier ajuste o reembolso; no se cambia el total aquí.',409);
    let status=order.status,expiresAt=order.payment_expires_at;
    if(!paid){
      requireValue(payments.length===1&&payments[0].status==='pending'&&['cash_on_delivery','manual_transfer'].includes(payments[0].provider),'El pago requiere revisión manual.',409);
      const deposit=order.full_payment_required?total:total>paymentPolicy.depositAboveCop?paymentPolicy.depositCop:0;
      expiresAt=deposit?new Date(new Date(order.starts_at).getTime()-12*3600000).toISOString():new Date(order.ends_at).toISOString();
      requireValue(new Date(expiresAt)>now,'El plazo para coordinar el abono ya cerró.',409);
      status=deposit?'awaiting_payment':'confirmed';
      await tx.query('UPDATE payments SET provider=$2,amount_cop=$3,updated_at=$4 WHERE id=$1',[payments[0].id,deposit?'manual_transfer':'cash_on_delivery',deposit||total,now.toISOString()]);
    }
    const coverage={...order.delivery_coverage,needsReview:false,method:input.method,reviewedBy:actor,reviewedAt:now.toISOString(),agreedDetails:input.details.trim()};
    if(input.method!=='delivery')delete coverage.capacityZone;
    await tx.query(`UPDATE orders SET delivery_address=$2,delivery_coverage=$3::jsonb,delivery_fee_cop=$4,delivery_discount_cop=$5,total_cop=$6,status=$7,payment_expires_at=$8,updated_at=$9 WHERE id=$1`,[order.id,input.details.trim(),JSON.stringify(coverage),input.deliveryFeeCop,discount,total,status,expiresAt,now.toISOString()]);
    await tx.query("UPDATE message_outbox SET status='cancelled' WHERE order_id=$1 AND kind IN ('order_confirmation','reservation_instructions') AND status IN ('pending','failed')",[order.id]);
    // The sender reconstructs reminder text from the resolved order, never an
    // old address/fee. Ensure a COD order converted from a deposit gets reminders.
    if(status==='confirmed')for(const hours of [24,6]){
      const due=new Date(new Date(order.starts_at).getTime()-hours*3600000);
      if(due>now)await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) SELECT gen_random_uuid(),$1,$2,$3,'Recordatorio King Cajun',$4,'pending',$5 WHERE NOT EXISTS(SELECT 1 FROM message_outbox WHERE order_id=$2 AND kind=$3)`,[order.customer_id,order.id,`reminder_${hours}h`,due.toISOString(),now.toISOString()]);
    }
    if(status==='confirmed'){
      await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) VALUES(gen_random_uuid(),$1,$2,'order_confirmation',$3,$4,'pending',$4)`,[order.customer_id,order.id,`✅ La entrega de tu pedido ${publicId} quedó coordinada.\n\n${orderConfirmationNotice({...order,delivery_coverage:coverage},now)}`,now.toISOString()]);
    }
    return {publicId,totalCop:total,depositCop:status==='awaiting_payment'?(order.full_payment_required?total:paymentPolicy.depositCop):0,method:input.method};
  });
}
