import {confirmOrderExtras} from './order-extras.mjs';
import {saleLineLabel,variableWeightNotice} from './crab-labels.mjs';
import {resolveDeliveryCoverage} from './delivery-coverage.mjs';
import {orderConfirmationNotice,deliveryWindowNotice} from './confirmation-notices.mjs';
import {recordStaffPayment} from './staff-payments.mjs';
import {staffPaymentCommand} from './staff-payment-commands.mjs';
export async function migrateStaffConfirmations(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_staff_events(
  event_id TEXT PRIMARY KEY,customer_phone TEXT NOT NULL,body TEXT NOT NULL,sent_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),order_id UUID REFERENCES orders(id),outcome TEXT NOT NULL,detail TEXT);
 CREATE TABLE IF NOT EXISTS whatsapp_chat_controls(customer_phone TEXT PRIMARY KEY,paused_until TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,updated_by TEXT NOT NULL);
 ALTER TABLE whatsapp_chat_controls ADD COLUMN IF NOT EXISTS manual_paused_at TIMESTAMPTZ;`);
}
export async function isChatPaused(db,phone,now=new Date()){
 return !!(await db.query('SELECT 1 FROM whatsapp_chat_controls WHERE customer_phone=$1 AND (manual_paused_at IS NOT NULL OR paused_until>$2)',[phone,now.toISOString()])).rowCount;
}
export const isStaffResumeCommand=text=>/^sigue[.!]?$/i.test(text.trim());
export const isExplicitStaffConfirmation=text=>!!staffPaymentCommand(text);
export async function releaseManualPause(tx,phone,eventId,now){
 const control=(await tx.query('SELECT * FROM whatsapp_chat_controls WHERE customer_phone=$1 FOR UPDATE',[phone])).rows[0];
 if(!control?.manual_paused_at)return false;
 // Preserve the customer's remaining reminder time; a staff takeover must not
 // trigger an immediate cancellation on resume. STOP time was already credited.
 await tx.query(`UPDATE message_outbox m SET confirmation_deadline_at=confirmation_deadline_at+
   GREATEST(interval '0 seconds',$2::timestamptz-GREATEST($3::timestamptz,LEAST($4::timestamptz,$2::timestamptz),COALESCE(m.delivery_confirmed_at,$3::timestamptz)))
   FROM customers c WHERE c.id=m.customer_id AND c.phone_e164=$1 AND m.confirmation_received_at IS NULL AND m.confirmation_deadline_at>$3`,
   [phone,now.toISOString(),control.manual_paused_at,control.paused_until]);
 await tx.query('UPDATE whatsapp_chat_controls SET manual_paused_at=NULL,paused_until=$2,updated_at=$2,updated_by=$3 WHERE customer_phone=$1',[phone,now.toISOString(),eventId]);
 return true;
}
export function isStaffOrderConfirmation(text){
 if(isExplicitStaffConfirmation(text))return true;
 const value=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
 // A business message is trusted as staff speech, but a question, quotation,
 // payment assertion or proposed price/date change is not approval of saved terms.
 if(/[?¿"“”]/.test(value)||/\b(no|aun|todavia|pendiente|cuando|si|falta|pago|abono|transferencia|cancel\w*|reembolso|cambiar|cambio|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(value)||/[$€]/.test(value))return false;
 if(/\d/.test(value.replace(/kc-[a-z0-9]+/g,'')))return false;
 return /^(listo[,! ]*)?(confirma|confirmado|confirmada)[.! ]*$/.test(value)
  || /\b(?:tu |el )?pedido (?:queda |esta |quedo )?confirmado\b/.test(value)
  || /^te confirmo (?:tu |el )?pedido[.! ]*$/.test(value)
  || /^(?:confirma|confirmar|confirmado) kc-[a-z0-9]+[.! ]*$/.test(value);
}
export async function applyStaffConfirmation(db,event,now=new Date(),options={}){
 return db.transaction(async tx=>{
  const claimed=await tx.query(`INSERT INTO whatsapp_staff_events(event_id,customer_phone,body,sent_at,outcome) VALUES($1,$2,$3,$4,'received') ON CONFLICT DO NOTHING RETURNING event_id`,[event.eventId,event.phone,event.text,event.sentAt]);
  if(!claimed.rowCount){
   // Explicit operational recovery only; ordinary webhook retries stay idempotent.
   const prior=options.retryNeedsReview?(await tx.query('SELECT * FROM whatsapp_staff_events WHERE event_id=$1 FOR UPDATE',[event.eventId])).rows[0]:null;
   if(!prior||prior.outcome!=='needs_review'||prior.customer_phone!==event.phone||prior.body!==event.text||+new Date(prior.sent_at)!==+new Date(event.sentAt))return {outcome:'duplicate'};
  }
  const finish=async(outcome,detail,orderId=null)=>{
   await tx.query('UPDATE whatsapp_staff_events SET outcome=$2,detail=$3,order_id=$4 WHERE event_id=$1',[event.eventId,outcome,detail,orderId]);
   return {outcome,detail,orderId};
  };
  // Past echoes must never approve a newer order in the same chat.
  const sentAt=new Date(event.sentAt);
  if(!Number.isFinite(+sentAt)||+sentAt>+now+60000||+now-+sentAt>24*3600000)return finish('needs_review','Mensaje antiguo o fecha no válida; revisar manualmente.');
  // Defensive guard: outbound API messages must never pause their own bot.
  if((await tx.query('SELECT 1 FROM message_outbox WHERE provider_message_id=$1',[event.eventId])).rowCount)return finish('ignored','Mensaje enviado por el bot.');
  const latest=(await tx.query(`SELECT cc.*,COALESCE(e.sent_at,cc.updated_at) AS last_event_at FROM whatsapp_chat_controls cc LEFT JOIN whatsapp_staff_events e ON e.event_id=cc.updated_by WHERE cc.customer_phone=$1 FOR UPDATE OF cc`,[event.phone])).rows[0];
  if(latest&&+new Date(latest.last_event_at)>+sentAt+999)return finish('ignored','Se conserva la acción de control más reciente.');
  if(/^stop[.!]?$/i.test(event.text.trim())){
   await tx.query(`INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,updated_at,updated_by,manual_paused_at) VALUES($1,$2,$2,$3,$2)
    ON CONFLICT(customer_phone) DO UPDATE SET manual_paused_at=COALESCE(whatsapp_chat_controls.manual_paused_at,excluded.manual_paused_at),updated_at=excluded.updated_at,updated_by=excluded.updated_by`,[event.phone,now.toISOString(),event.eventId]);
   await tx.query("UPDATE message_outbox m SET status='cancelled' FROM customers c WHERE c.id=m.customer_id AND c.phone_e164=$1 AND m.kind='staff_resume' AND m.status IN ('pending','failed')",[event.phone]);
   return finish('paused','IA pausada en este chat hasta SIGUE.');
  }
  if(isStaffResumeCommand(event.text)){
   if(!options.resumeChat)return finish('needs_review','No está disponible la reanudación de este chat.');
   const conversation=(await tx.query('SELECT updated_at FROM conversations WHERE phone_e164=$1 FOR UPDATE',[event.phone])).rows[0];
   if(conversation&&+new Date(conversation.updated_at)>+sentAt+999)return finish('ignored','El chat cambió después de SIGUE; se conserva la acción más reciente.');
   const resumed=await options.resumeChat(tx,event,now);
   if(resumed?.needsReview)return finish('needs_review',resumed.detail,resumed.orderId??null);
   return finish('applied','IA retomada por SIGUE; datos del chat revisados y siguiente paso preparado, sin registrar pagos recibidos.',resumed?.orderId??null);
  }
  if(!isStaffOrderConfirmation(event.text)){
   await tx.query(`INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,updated_at,updated_by,manual_paused_at) VALUES($1,$2,$2,$3,$2)
    ON CONFLICT(customer_phone) DO UPDATE SET manual_paused_at=COALESCE(whatsapp_chat_controls.manual_paused_at,excluded.manual_paused_at),updated_at=excluded.updated_at,updated_by=excluded.updated_by`,[event.phone,now.toISOString(),event.eventId]);
   await tx.query("UPDATE message_outbox m SET status='cancelled' FROM customers c WHERE c.id=m.customer_id AND c.phone_e164=$1 AND m.kind='staff_resume' AND m.status IN ('pending','failed')",[event.phone]);
   return finish('paused','Atención manual: IA pausada hasta SIGUE.');
  }
  const refs=[...new Set((event.text.match(/kc-[a-z0-9]+/ig)??[]).map(s=>s.toUpperCase()))];
  if(refs.length>1)return finish('needs_review','El mensaje menciona varios pedidos.');
  const orders=(await tx.query(`SELECT o.*,w.starts_at FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
   WHERE c.phone_e164=$1 AND o.status IN ('confirmed','awaiting_payment')
   AND o.created_at<=$2 AND w.starts_at>$3 AND ($4::text IS NULL OR o.public_id=$4)`,[event.phone,event.sentAt,now.toISOString(),refs[0]??null])).rows;
  const draft=(await tx.query('SELECT context_json FROM conversations WHERE phone_e164=$1 FOR UPDATE',[event.phone])).rows[0]?.context_json;
  if(orders.length>1||orders.length===1&&!refs.length&&draft?.orderingOptIn&&draft?.cart?.length)return finish('needs_review','Hay varios pedidos o un borrador activo; envía CONFIRMADO seguido de la referencia KC-… para elegir un pedido registrado.');
  if(!orders.length&&(refs.length||!options.createDraft))return finish('needs_review','No hay un pedido completo registrado para este mensaje. Revisar los datos que faltan en el chat.');
  let order=orders[0];
  await tx.exec('SAVEPOINT staff_order');
  try{
   if(!order){
    const orderId=await options.createDraft(tx,event,now);
    order=(await tx.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
   }
   const preference=order.delivery_coverage?.preference;
   const method=preference==='pickup'?'pickup':preference==='own_courier'?'own_courier':'delivery';
   // Resolve in the same transaction, preserving the existing staff/kitchen lock order.
   if(order.delivery_coverage?.needsReview)await resolveDeliveryCoverage({transaction:callback=>callback(tx)},order.public_id,{agreedWithCustomer:true,method,details:order.delivery_address,deliveryFeeCop:method==='delivery'?order.delivery_fee_cop:0},'WhatsApp Business · '+event.eventId,now);
   let depositReceived=0,extrasReceived=null;
   if(orders.length===1&&isExplicitStaffConfirmation(event.text)){
    const current=(await tx.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0];
    const paidBefore=(await tx.query("SELECT COALESCE(SUM(amount_cop),0)::int AS amount FROM payments WHERE order_id=$1 AND status='confirmed'",[order.id])).rows[0].amount;
    const extra=(await tx.query("SELECT * FROM order_extras WHERE order_id=$1 AND status='pending'",[order.id])).rows[0];
    const amount=staffPaymentCommand(event.text).amountCop;
    const evidence=amount?{totalPaidCop:paidBefore+amount,previousPaidCop:paidBefore,basis:'explicit_owner_installment',keys:[],evidenceIds:[event.eventId],summary:'Nuevo abono indicado por el dueño: '+amount+' COP.'}
     :options.readPaymentEvidence?await options.readPaymentEvidence(tx,event,{...current,total_cop:current.total_cop+(extra?.total_cop??0)},now)
     :paidBefore>=current.total_cop&&!extra?{totalPaidCop:paidBefore,previousPaidCop:paidBefore,basis:'already_paid',keys:[],evidenceIds:[]}:null;
    if(!evidence)throw Object.assign(new Error('No se puede identificar el monto recibido. Envía CONFIRMADO seguido del nuevo abono aún no registrado en COP, por ejemplo CONFIRMADO 50.000.'),{status:409});
    const delta=evidence.totalPaidCop-paidBefore;
    if(extra&&current.status==='confirmed'&&(delta===extra.total_cop||evidence.totalPaidCop===current.total_cop+extra.total_cop)){
     // Validate evidence before the existing extras path records its payment.
     const priorKeys=(await tx.query("SELECT raw_payload_json FROM payments WHERE order_id=$1 AND status='confirmed'",[order.id])).rows.flatMap(p=>p.raw_payload_json?.evidenceKeys??[]);
     if((evidence.keys??[]).some(k=>priorKeys.includes(k)))throw Object.assign(new Error('Ese comprobante ya fue contabilizado. Si llegó otro pago, indica solo ese nuevo abono con CONFIRMADO 50.000.'),{status:409});
     extrasReceived=await confirmOrderExtras(tx,order.id,event,now);
     await tx.query("UPDATE payments SET raw_payload_json=COALESCE(raw_payload_json,'{}'::jsonb)||$2::jsonb WHERE provider_payment_id=$1",['WA-EXTRAS:'+extra.id,JSON.stringify({evidenceKeys:evidence.keys??[],evidenceIds:evidence.evidenceIds??[],evidenceThrough:event.sentAt})]);
     evidence.previousPaidCop+=extra.total_cop;
     // Remaining amount from a combined transfer is recorded by the same event.
     if(evidence.totalPaidCop>evidence.previousPaidCop)evidence.keys=[];
    }
    const payment=await recordStaffPayment(tx,order.id,event,evidence,now);
    depositReceived=payment.amountCop;
    await tx.query("UPDATE message_outbox SET status='cancelled' WHERE order_id=$1 AND kind='deposit_confirmation' AND status='pending'",[order.id]);
   }
   const saved=(await tx.query('SELECT o.*,w.starts_at,w.ends_at FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1 FOR UPDATE OF o',[order.id])).rows[0];
   const lines=(await tx.query('SELECT item_name_snapshot,quantity,line_total_cop,customization_json FROM order_line_items WHERE order_id=$1',[order.id])).rows;
   const money=value=>new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(value);
   const date=value=>new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value));
   const paid=(await tx.query("SELECT COALESCE(SUM(amount_cop),0)::int AS amount FROM payments WHERE order_id=$1 AND status='confirmed'",[order.id])).rows[0].amount;
   const pendingDeposit=saved.status==='awaiting_payment';
   const body=`${pendingDeposit?(saved.full_payment_required?'🧾 Entrega coordinada · pendiente de pago completo':'🧾 Entrega coordinada · pendiente de abono'):'✅ Pedido confirmado'}\nReferencia: ${saved.public_id}${extrasReceived?'\n✅ Extras pagados: '+money(extrasReceived.amountCop)+' · '+extrasReceived.reference:''}\n\n${lines.map(l=>`${saleLineLabel(l.item_name_snapshot,l.quantity,l.customization_json)}${l.customization_json?.spice?' · '+l.customization_json.spice:''} · ${money(l.line_total_cop)}`).join('\n')}${variableWeightNotice(lines.map(l=>l.customization_json))}\n\nEntrega: ${date(saved.starts_at)} a ${new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',hour:'numeric',minute:'2-digit'}).format(new Date(saved.ends_at))}\n${saved.delivery_address}\nTotal: ${money(saved.total_cop)}${paid>0?'\n'+(paid>=saved.total_cop?'Pago completo recibido: ':'Abono recibido: ')+money(paid):''}\nSaldo pendiente${paid>0&&!pendingDeposit&&paid<saved.total_cop?' contra entrega':''}: ${money(Math.max(0,saved.total_cop-paid))}${pendingDeposit?(paid>0?'\nRecibimos este pago. Falta completar el valor requerido para confirmar la reserva.':'\nLa reserva sigue pendiente de verificar el pago con el equipo.')+(options.paymentInstructions?'\n\n'+options.paymentInstructions:''):''}\n\n${pendingDeposit?deliveryWindowNotice(saved.delivery_coverage):orderConfirmationNotice(saved,now)}`;
   await tx.query("UPDATE message_outbox SET status='cancelled' WHERE order_id=$1 AND kind IN ('order_confirmation','reservation_instructions','staff_order_confirmation') AND status IN ('pending','failed')",[order.id]);
   await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) VALUES(gen_random_uuid(),$1,$2,'staff_order_confirmation',$3,$4,'pending',$4)`,[saved.customer_id,order.id,body,now.toISOString()]);
   // A payment command sends its receipt, but does not end staff's conversation.
   // Only SIGUE releases a manual pause.
   await tx.exec('RELEASE SAVEPOINT staff_order');
   return finish('applied',extrasReceived?`Extras ${extrasReceived.reference}: pago de ${money(extrasReceived.amountCop)} verificado y empaque actualizado.`:depositReceived?`Pago de ${money(depositReceived)} registrado por CONFIRMADO; total recibido ${money(paid)}; saldo ${money(Math.max(0,saved.total_cop-paid))}. ${pendingDeposit?'Reserva pendiente de completar el pago.':'Pedido confirmado.'}`:`Confirmación manual vinculada a ${order.public_id}; estado de pago conservado.`,order.id);
  }catch(error){
   // Validation errors are actionable in the dashboard; database errors retry.
   if(!error?.status)throw error;
   await tx.exec('ROLLBACK TO SAVEPOINT staff_order');
   await tx.exec('RELEASE SAVEPOINT staff_order');
   return finish('needs_review',error.message,orders[0]?.id??null);
  }
 });
}
