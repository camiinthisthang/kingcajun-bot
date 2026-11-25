import {bookingType} from '../../admin-dashboard/src/booking-capacity.mjs';
import {pickupLocationNotice,deliveryWindowNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';
import {crabExplanation,refreshWholePieceDraft} from './crab-portions.js';
import {saleLineLabel} from '../../admin-dashboard/src/crab-labels.mjs';
import type {Config} from '../config.js';
import type {Db,DbClient} from '../db/index.js';
import type {ConversationContext,ConversationState} from '../types.js';
import {OrderService} from './orders.js';
import {CashOnDeliveryPaymentProvider} from '../providers/payment.js';
import {configuredMainMenuButtons} from './main-menu.js';
import {readFlow} from '../../admin-dashboard/src/flow/store.mjs';
import {specialDeliveryZone,locationFromAddress} from './delivery-coverage.js';
import {windowLabel,cop} from '../lib/format.js';
import {releaseManualPause} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {StaffDraftReader} from './staff-draft-reader.js';
import {fullPaymentInstructions} from './full-payment.js';
import {orderingPauseReply} from './ordering-pause.js';

async function savedOrderMessage(tx:DbClient,cfg:Config,id:string){
 const o=(await tx.query<any>(`SELECT o.*,w.starts_at,w.ends_at,COALESCE((SELECT SUM(amount_cop) FROM payments WHERE order_id=o.id AND status='confirmed'),0)::int AS paid FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1`,[id])).rows[0];
 const lines=(await tx.query<any>('SELECT * FROM order_line_items WHERE order_id=$1 ORDER BY id',[id])).rows;
 const remaining=Math.max(0,o.total_cop-o.paid),pending=o.status==='awaiting_payment',reviewingPayment=o.status==='payment_review';
 const pendingAmount=(await tx.query<any>("SELECT COALESCE(SUM(amount_cop),0)::int AS amount FROM payments WHERE order_id=$1 AND provider='manual_transfer' AND status='pending'",[id])).rows[0].amount;
 const due=o.full_payment_required?remaining:Math.min(remaining,pendingAmount||remaining);
 const method=o.delivery_coverage?.method??o.delivery_coverage?.preference;
 const items=lines.map(l=>`• ${saleLineLabel(l.item_name_snapshot,l.quantity,l.customization_json)}${l.customization_json?.spice?' · '+l.customization_json.spice:''} · ${cop(l.line_total_cop)}`).join('\n');
 return `${reviewingPayment?'🧾 *Comprobante en revisión*':pending?(o.full_payment_required?'🧾 *Pedido registrado · pendiente de pago completo*':'🧾 *Pedido registrado · pendiente del abono acordado*'):o.delivery_coverage?.needsReview?'🧾 *Pedido registrado · entrega por revisar*':'✅ *Pedido confirmado*'}\nReferencia: *${o.public_id}*\n\n${items}\n\n📅 ${windowLabel(o.starts_at,o.ends_at,cfg.BUSINESS_TIMEZONE)}\n${['pickup','own_courier'].includes(method)?'📦 Recogida en El Poblado':o.delivery_address}\nDomicilio: ${cop(o.delivery_fee_cop-o.delivery_discount_cop)}\n\n*Total: ${cop(o.total_cop)}*${o.paid?'\nPago recibido: '+cop(o.paid):''}\n*Saldo pendiente: ${cop(remaining)}*`+
  (remaining&&!reviewingPayment&&(pending||o.full_payment_required)?`\n\n${o.full_payment_required?fullPaymentInstructions(cfg.MANUAL_TRANSFER_INSTRUCTIONS):cfg.MANUAL_TRANSFER_INSTRUCTIONS}\nValor a transferir: *${cop(due)}*\nReferencia: ${o.public_id}\nEnvía el comprobante por este chat. Confirmaremos tu pedido cuando el equipo verifique ${o.full_payment_required?'el pago completo':'el abono acordado'}.`:'')+
  (reviewingPayment?'\n\nEl equipo está revisando el comprobante; no necesitas pagar otra vez.':'')+
  (o.delivery_coverage?.needsReview?'\n\nEl equipo revisará la dirección; la confirmación final requiere verificar la cobertura.':'')+'\n\n'+deliveryWindowNotice(o.delivery_coverage);
}

// SIGUE hands the conversation back. It may register an unpaid order from
// evidenced chat details, but can never record money as received.
export function staffResumeHandler(cfg:Config){
 return async(tx:DbClient,event:{phone:string;eventId:string;sentAt:string},now:Date)=>{
  const row=(await tx.query<{context_json:ConversationContext}>('SELECT context_json FROM conversations WHERE phone_e164=$1 FOR UPDATE',[event.phone])).rows[0];
  let c:ConversationContext=structuredClone(row?.context_json??{});
  const db:Db={...tx,transaction:async work=>work(tx),close:async()=>{}};
  const orders=new OrderService(db,cfg,new CashOnDeliveryPaymentProvider());
  await orders.loadMenu();const menu=orders.menu();
  let state:ConversationState='MAIN_MENU',body='🦀 Ya estoy de vuelta. ¿En qué te ayudo?',buttons:ReturnType<typeof configuredMainMenuButtons>|null=null,orderId:string|null=null;
  const existing=(await tx.query<any>(`SELECT o.id,o.public_id FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE c.phone_e164=$1 AND o.status IN ('confirmed','awaiting_payment','payment_review') AND w.starts_at>$2 AND (o.status<>'awaiting_payment' OR o.payment_expires_at>$2) ORDER BY o.created_at DESC`,[event.phone,now.toISOString()])).rows;
  if(existing.length){
   if(existing.length===1){orderId=existing[0].id;body=await savedOrderMessage(tx,cfg,orderId!);}
   else body='Tienes varios pedidos registrados ('+existing.map(o=>o.public_id).join(', ')+'). ¿Cuál quieres retomar?';
   state=c.orderingOptIn?'REVIEWING':'MAIN_MENU';
  }else{
   let question:string|undefined;
   const calendar=(await tx.query<any>("SELECT id::text,starts_at,ends_at FROM delivery_windows WHERE status='open' AND (order_opens_at IS NULL OR order_opens_at<=$1) AND ends_at>$1 ORDER BY starts_at",[now.toISOString()])).rows;
   try{const read=await new StaffDraftReader(cfg).read(tx,event,c,menu,calendar);c=read.context;question=read.question;}
   catch(error){
    await tx.query(`INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,manual_paused_at,updated_at,updated_by) VALUES($1,$2,$2,$2,$3) ON CONFLICT(customer_phone) DO UPDATE SET manual_paused_at=COALESCE(whatsapp_chat_controls.manual_paused_at,excluded.manual_paused_at),updated_at=excluded.updated_at,updated_by=excluded.updated_by`,[event.phone,now.toISOString(),event.eventId]);
    const reason=error instanceof Error?error.message:'Error desconocido';
    return {orderId:null,needsReview:true,detail:'SIGUE no pudo recuperar el pedido: '+reason.slice(0,600)+'. IA permanece pausada; no se solicitó repetir datos al cliente.'};
   }
   if(c.orderingOptIn){
    if(c.menuVersion!==orders.menuVersion())refreshWholePieceDraft(c,menu);
    c.fullPrepayment=true;
    const cart=c.cart??[],location=c.deliveryLocation??locationFromAddress(c.deliveryAddress??'');
    const windows=await orders.availableWindows(bookingType(c.deliveryPreference),false,true,specialDeliveryZone(location));
    const chosen=windows.find(w=>w.id===c.windowId);
    const coverage=await orders.coverage(location,c.deliveryPreference,c.windowId);
    if(!question){
     if(cfg.NEW_ORDERS_PAUSED){state='REVIEWING';question=orderingPauseReply(cfg);}
     else if(cart.some(l=>!menu.some(i=>i.id===l.menuItemId||i.slug===l.menuItemId))){state='CHOOSING_ITEM';question='Uno de los productos que elegiste no está disponible. ¿Qué te gustaría pedir en su lugar?';}
     else if(c.pendingCrabPortions?.length){state='CHOOSING_ITEM';question=crabExplanation(menu.find(i=>i.id===c.pendingCrabPortions![0]!.itemId)!);}
     else if(!cart.some(l=>menu.find(i=>i.id===l.menuItemId||i.slug===l.menuItemId)?.category==='plate')){state='CHOOSING_ITEM';question='¿Qué combo o mariscos quieres y cuántos?';}
     else if(c.pendingSelection||cart.some(l=>menu.find(i=>i.id===l.menuItemId||i.slug===l.menuItemId)?.category==='plate'&&!l.customization?.spice)){state='CHOOSING_SPICE';question='¿Qué picante prefieres: suave o medio?';}
     else if(!chosen){
      state='CHOOSING_WINDOW';delete c.windowId;c.offeredWindowIds=windows.map(w=>w.id);
      question=windows.length?'¿Qué fecha y horario te sirven?\n'+windows.map((w,i)=>`${i+1}. ${windowLabel(w.starts_at,w.ends_at,cfg.BUSINESS_TIMEZONE)} · pago completo por transferencia`).join('\n'):'Por ahora no quedan franjas abiertas. Tu selección sigue guardada.';
     }else if(!c.deliveryAddress&&bookingType(c.deliveryPreference)==='delivery'){state='ENTERING_ADDRESS';question='¿A qué dirección lo llevamos? Incluye el número y los detalles de acceso.';}
     else if(c.pendingReferralCode){state='REVIEWING';question='Solo falta corregir el código o decir «sin código» para seguir.';}
     else{
      if(coverage.needsReview){coverage.preference='review';c.deliveryPreference='review';}
      if(c.deliveryContactPhones?.length)coverage.contactPhones=c.deliveryContactPhones;
      if(c.deliverySingleContactAccepted)coverage.singleContactAccepted=true;
      await tx.query("SELECT id FROM kitchen_runs WHERE delivery_date=(SELECT (starts_at AT TIME ZONE 'America/Bogota')::date FROM delivery_windows WHERE id=$1) FOR UPDATE",[c.windowId]);
      await tx.exec('SAVEPOINT resume_order');
      try{
       const created=await orders.create({phone:event.phone,cart,fulfillmentType:'delivery',fullPrepayment:true,windowId:c.windowId!,deliveryAddress:c.deliveryAddress||pickupLocationNotice,deliveryCoverage:coverage,referralCode:c.referralCode,extrasDeclined:c.extrasDeclined,expectedMenuVersion:orders.menuVersion(),expectedTotalCop:(await orders.quote(cart,c.referralCode,c.deliveryPreference)).total});
       orderId=created.orderId;body=await savedOrderMessage(tx,cfg,orderId);c={};state='MAIN_MENU';
       await tx.exec('RELEASE SAVEPOINT resume_order');
      }catch(error){
       orderId=null;
       await tx.exec('ROLLBACK TO SAVEPOINT resume_order');await tx.exec('RELEASE SAVEPOINT resume_order');
       if(!(error instanceof Error)||'code' in error)throw error;
       state='REVIEWING';question='Conservé los datos, pero no pude registrar el pedido: '+error.message;
      }
     }
    }
    if(!orderId){
     c.menuVersion=orders.menuVersion();
     const summary=cart.map(l=>`${saleLineLabel(menu.find(i=>i.id===l.menuItemId||i.slug===l.menuItemId)?.name??'producto por revisar',l.quantity,l.customization)}${l.customization?.spice?' · '+l.customization.spice:''}`).join(', ');
     if(state==='MAIN_MENU')state='REVIEWING';
     body=`🦀 Retomemos tu pedido.${summary?' Tengo: '+summary+'.':''}\n\n${question}`;
    }
   }else if(question)body=question;
   else buttons=configuredMainMenuButtons((await readFlow(db)).published.messages);
  }
  const iso=now.toISOString();
  await releaseManualPause(tx,event.phone,event.eventId,now);
  await tx.query(`INSERT INTO conversations(phone_e164,state,context_json,updated_at) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(phone_e164) DO UPDATE SET state=excluded.state,context_json=excluded.context_json,updated_at=excluded.updated_at`,[event.phone,state,JSON.stringify(c),iso]);
  await tx.query('UPDATE whatsapp_chat_controls SET paused_until=$2,updated_at=$2,updated_by=$3 WHERE customer_phone=$1',[event.phone,iso,event.eventId]);
  await tx.query("UPDATE message_outbox m SET status='cancelled' FROM customers c WHERE c.id=m.customer_id AND c.phone_e164=$1 AND m.kind='staff_resume' AND m.status IN ('pending','failed')",[event.phone]);
  await tx.query(`INSERT INTO customers(id,phone_e164,locale,created_at,updated_at) VALUES(gen_random_uuid(),$1,'es-CO',$2,$2) ON CONFLICT(phone_e164) DO NOTHING`,[event.phone,iso]);
  await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,buttons_json,due_at,status,created_at) SELECT gen_random_uuid(),id,$2,'staff_resume',$3,$4::jsonb,$5,'pending',$5 FROM customers WHERE phone_e164=$1`,[event.phone,orderId,body,buttons?JSON.stringify(buttons):null,iso]);
  return {orderId};
 };
}
