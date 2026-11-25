import {randomUUID} from 'node:crypto';
import {runTicketStory,botActor} from './runtime.mjs';
import {enqueueTicketEvent} from './jobs.mjs';

export async function posWindows(db,includeFull=false){
  const rows=(await db.query(`SELECT w.*,(w.capacity-count(o.id))::int AS remaining,(w.capacity-count(o.id))::int AS daily_remaining,0 AS prepaid_remaining,FALSE AS prepayment_required,FALSE AS date_full_payment_required,TRUE AS pickup_available FROM delivery_windows w LEFT JOIN orders o ON o.delivery_window_id=w.id AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>now()) WHERE w.pos_enabled=TRUE AND w.status='open' AND w.starts_at>now() AND w.order_cutoff_at>now() AND (w.order_opens_at IS NULL OR w.order_opens_at<=now()) GROUP BY w.id ORDER BY w.starts_at`)).rows;
  return includeFull?rows:rows.filter(w=>w.remaining>0);
}
export async function attachDelivery(tx,orderId){
  const existing=(await tx.query('SELECT * FROM dine_in_tickets WHERE source_order_id=$1',[orderId])).rows[0];if(existing)return existing;
  const order=(await tx.query('SELECT o.*,w.pos_enabled FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1 FOR UPDATE OF o',[orderId])).rows[0];
  if(!order?.pos_enabled)return null;
  const rows=(await tx.query('SELECT * FROM order_line_items WHERE order_id=$1 ORDER BY id',[orderId])).rows;
  const items=rows.map(r=>({productId:r.menu_item_id,name:r.item_name_snapshot,quantity:Number(r.quantity),priceCop:Number(r.unit_price_cop),portion:'porción',heat:r.customization_json?.spice||'',notes:r.customization_json?.notes||'',recipe:r.kitchen_snapshot_json||null}));
  const t=(await tx.query(`INSERT INTO dine_in_tickets(visit_id,round,state,version,waiter,notes,items,device_id,created_at,updated_at,source_order_id) VALUES(NULL,1,'reserved',1,'WhatsApp',$1,$2::jsonb,$3,now(),now(),$4) RETURNING *`,[`${order.public_id} · ${order.delivery_address}\n${order.notes||''}`,JSON.stringify(items),randomUUID(),orderId])).rows[0];
  const required=(await tx.query("SELECT 1 FROM payments WHERE order_id=$1 AND provider<>'cash_on_delivery' LIMIT 1",[orderId])).rows.length>0;
  await runTicketStory(tx,t,'DeliveryBot reserves Ticket for Slot',botActor,{creating:true,slotId:order.delivery_window_id,fields:{reference:order.public_id,channel:'delivery',confirmed:true,paymentRequired:required,paymentVerified:false}});
  await tx.query("UPDATE orders SET delivery_coverage=COALESCE(delivery_coverage,'{}'::jsonb)||'{\"posWorkflow\":true}'::jsonb WHERE id=$1",[orderId]);
  await reconcileTicket(tx,t.id);
  return (await tx.query('SELECT * FROM dine_in_tickets WHERE id=$1',[t.id])).rows[0];
}
async function reconcileTicket(tx,ticketId){
  const t=(await tx.query('SELECT t.*,o.status AS order_status,o.delivery_coverage FROM dine_in_tickets t JOIN orders o ON o.id=t.source_order_id WHERE t.id=$1 FOR UPDATE OF o',[ticketId])).rows[0];
  if(!t||t.state!=='reserved')return;
  let story;
  const paid=(await tx.query("SELECT 1 FROM payments WHERE order_id=$1 AND status='confirmed' LIMIT 1",[t.source_order_id])).rows.length>0;
  if(['cancelled','expired'].includes(t.order_status))story='DeliveryBot releases Ticket';
  else if(t.order_status==='confirmed'&&!t.delivery_coverage?.needsReview)story='DeliveryBot accepts Ticket';
  if(!story)return;
  const updated=await runTicketStory(tx,t,story,botActor,{fields:{paymentVerified:paid}});
  await tx.query('UPDATE dine_in_tickets SET version=version+1,updated_at=now() WHERE id=$1',[t.id]);
  const saved=(await tx.query('SELECT * FROM dine_in_tickets WHERE id=$1',[t.id])).rows[0];
  if(updated.status==='new')await enqueueTicketEvent(tx,saved,'new');
  await tx.query('INSERT INTO dine_in_events(ticket_id,action,detail,at) VALUES($1,$2,$3,now())',[t.id,updated.status,'WhatsApp · confirmación y pago verificados según las condiciones del pedido']);
}
export async function reconcileDeliveries(db){return db.transaction(async tx=>{
  await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR UPDATE');
  await tx.query("UPDATE orders SET status='expired',updated_at=now() WHERE status='awaiting_payment' AND payment_expires_at<=now()");
  const rows=(await tx.query("SELECT id FROM dine_in_tickets WHERE source_order_id IS NOT NULL AND state='reserved' ORDER BY id")).rows;
  for(const row of rows)await reconcileTicket(tx,row.id);
});}
export async function requestDeliveryCancellation(tx,order,phone){
  const t=(await tx.query('SELECT t.* FROM dine_in_tickets t JOIN orders o ON o.id=t.source_order_id JOIN customers c ON c.id=o.customer_id WHERE t.source_order_id=$1 AND c.phone_e164=$2',[order.id,phone])).rows[0];
  if(!t)return null;
  if(t.state==='cancel_requested')return {...order,cancellationPending:true};
  if(t.state==='cancelled')return {...order,alreadyCancelled:true};
  const reserved=t.state==='reserved';
  const result=await runTicketStory(tx,t,reserved?'DeliveryBot releases Ticket':'DeliveryBot requests Ticket',botActor);
  await tx.query("UPDATE dine_in_tickets SET version=version+1,cancel_reason='Solicitud del cliente por WhatsApp',updated_at=now() WHERE id=$1",[t.id]);
  if(reserved)await tx.query("UPDATE orders SET status='cancelled',updated_at=now(),refund_status=CASE WHEN EXISTS(SELECT 1 FROM payments WHERE order_id=$1 AND status='confirmed') THEN 'pending' ELSE refund_status END WHERE id=$1",[order.id]);
  await enqueueTicketEvent(tx,(await tx.query('SELECT * FROM dine_in_tickets WHERE id=$1',[t.id])).rows[0],result.status);
  return {...order,alreadyCancelled:false,cancellationPending:!reserved};
}
