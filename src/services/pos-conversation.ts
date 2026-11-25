import {randomUUID} from 'node:crypto';
import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import type {InboundMessage,CartLine} from '../types.js';
import type {OrderService} from './orders.js';
import type {MessagingService} from './messaging.js';
import {coverageSnapshot,locationFromAddress} from './delivery-coverage.js';
import {isChatPaused} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {paymentPolicy} from '../business-policy.js';
const cop=(n:number)=>new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(n);
const label=(w:any)=>new Date(w.starts_at).toLocaleString('es-CO',{timeZone:'America/Bogota',weekday:'short',hour:'numeric',minute:'2-digit'})+'–'+new Date(w.ends_at).toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'numeric',minute:'2-digit'});

// Guided POS checkout uses the existing signed webhook, customer records,
// messaging provider, catalog, payment policy and OrderService transaction.
// It cannot invent products, delivery coverage, payments or kitchen progress.
export async function handlePosConversation(db:Db,cfg:Config,orders:OrderService,messaging:MessagingService,m:InboundMessage){
 if(await isChatPaused(db,m.phone))return {mode:'staff_paused',replied:false};
 const text=m.text.trim(),norm=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const send=(body:string)=>messaging.sendNow(m.phone,body,'pos_conversation');
 const save=(ctx:any)=>db.query('INSERT INTO pos_chats(phone,context) VALUES($1,$2::jsonb) ON CONFLICT(phone) DO UPDATE SET context=excluded.context,updated_at=now()',[m.phone,JSON.stringify(ctx)]);
 const ctx:any=(await db.query('SELECT context FROM pos_chats WHERE phone=$1',[m.phone])).rows[0]?.context||{};
 if(norm==='equipo'){await send('Listo, el equipo continuará contigo por este chat.');await db.query("INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,manual_paused_at,updated_at,updated_by) VALUES($1,now(),now(),now(),'customer-pos-handoff') ON CONFLICT(customer_phone) DO UPDATE SET manual_paused_at=now(),updated_at=now(),updated_by='customer-pos-handoff'",[m.phone]);return {handoff:true};}
 const reference=text.match(/KC-[A-Z0-9]+/i)?.[0];
 if(reference&&/cancel/.test(norm)){
  const result=await orders.cancel(reference,m.phone);
  await send(result.cancellationPending?'Tu solicitud quedó registrada. Cocina debe confirmar la cancelación; todavía no está cancelado.':`La cancelación de ${reference.toUpperCase()} está confirmada. Si hiciste un pago, el equipo revisará el reembolso.`);return {cancellation:result.cancellationPending?'pending':'cancelled'};
 }
 if(/^(estado|mi pedido)/.test(norm)||(ctx.step==='done'&&!/^(menu|nuevo|hacer pedido|pedir)$/.test(norm))){
  const t:any=(await db.query(`SELECT o.public_id,o.status,t.state FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN dine_in_tickets t ON t.source_order_id=o.id WHERE c.phone_e164=$1 ORDER BY o.created_at DESC LIMIT 1`,[m.phone])).rows[0];
  const names:Record<string,string>={reserved:'Esperando verificación del pago',new:'En la fila de cocina',cooking:'En preparación',ready:'Listo para despachar',dispatched:'En camino',served:'Entregado',cancel_requested:'Cancelación pendiente de aprobación',cancelled:'Cancelado'};
  await send(t?`${t.public_id}: ${names[t.state]||t.status}. Escribe EQUIPO si necesitas ayuda o NUEVO para hacer otro pedido.`:'Todavía no tienes un pedido registrado. Escribe MENÚ para empezar.');return {status:true};
 }
 if(cfg.NEW_ORDERS_PAUSED){await send('En este momento no estamos recibiendo pedidos nuevos. Puedes escribir ESTADO para consultar tu pedido.');return {paused:true};}
 await orders.loadMenu();
 const menu=orders.menu();
 const showMenu=async()=>{await save({step:'cart',menuIds:menu.map(p=>p.id),checkoutId:randomUUID()});await send('¡Hola! 🦀 Hagamos tu pedido de King Cajun.\n\n'+menu.map((p,i)=>`${i+1}. ${p.name} · ${cop(p.price_cop)}`).join('\n')+'\n\nResponde con número y cantidad: 1x2, 20x1. Antes de confirmar revisarás el total y una franja con cupo. Escribe NUEVO para empezar de nuevo.');};
 const showSlots=async()=>{const slots=await orders.availableWindows('delivery');if(!slots.length){await save({...ctx,step:'slot',slots:[]});await send('Las franjas disponibles están llenas o cerradas. Conservamos tu selección. Escribe CUPOS para volver a consultar; todavía no creamos un pedido.');return;}
  ctx.slots=slots.map(w=>({id:w.id,label:label(w)}));ctx.step='slot';await save(ctx);await send('Elige tu franja de entrega:\n'+slots.map((w,i)=>`${i+1}. ${label(w)} · ${w.remaining} cupo(s)`).join('\n')+'\nResponde con el número. El cupo se asegura al confirmar el pedido.');};
 if(/^(menu|nuevo|hacer pedido|pedir)$/.test(norm)||!ctx.step||ctx.step==='done'){await showMenu();return {step:'cart'};}
 if(ctx.step==='cart'){
  const choices=text.split(',').map(s=>s.trim().match(/^(\d{1,2})(?:\s*[xX*]\s*(\d{1,2}))?$/));
  if(choices.some(c=>!c)){await send('Para registrar exactamente lo que quieres, usa el número del menú y la cantidad. Ejemplo: 1x2, 20x1. Escribe MENÚ si quieres verlo otra vez.');return {step:'cart'};}
  const cart:CartLine[]=choices.map(c=>({menuItemId:ctx.menuIds[Number(c![1])-1],quantity:Number(c![2]||1),customization:{spice:'Suave'}}));
  if(cart.some(l=>!menu.some(p=>p.id===l.menuItemId)||l.quantity<1||l.quantity>30)||!cart.some(l=>menu.find(p=>p.id===l.menuItemId)?.category==='plate')){await send('Elige al menos un plato y cantidades entre 1 y 30. Escribe MENÚ para revisar las opciones.');return {step:'cart'};}
  ctx.cart=cart;ctx.step='address';await save(ctx);await send('¿A qué dirección lo llevamos? Incluye calle, número, apartamento y barrio. Ejemplo: Calle 10 #40-20, apto 301, El Poblado, Medellín.');return {step:'address'};
 }
 if(ctx.step==='address'){
  if(text.length<10||text.length>500){await send('Envíanos una dirección completa, con barrio y apartamento si aplica.');return {step:'address'};}
  const coverage=coverageSnapshot(locationFromAddress(text));
  if(coverage.needsReview){await send('Necesitamos revisar esa dirección con el equipo antes de prometer la entrega. Tu selección sigue guardada. Puedes enviarnos la dirección con el barrio o escribir EQUIPO.');return {step:'address',needsReview:true};}
  ctx.address=text;ctx.coverage=coverage;await showSlots();return {step:ctx.step};
 }
 if(ctx.step==='slot'){
  if(norm==='cupos'||!ctx.slots?.length){await showSlots();return {step:ctx.step};}
  const slot=/^\d+$/.test(text)?ctx.slots[Number(text)-1]:null;
  if(!slot){await send('Responde con el número de la franja o escribe CUPOS para actualizar la disponibilidad.');return {step:'slot'};}
  ctx.windowId=slot.id;ctx.quote=await orders.quote(ctx.cart,undefined,'delivery');ctx.menuVersion=orders.menuVersion();ctx.step='confirm';await save(ctx);
  const payment=cfg.NEW_ORDERS_FULL_PAYMENT||cfg.PAYMENT_PROVIDER!=='cash_on_delivery'?'Requiere pago anticipado y verificación antes de entrar a cocina.':ctx.quote.total>paymentPolicy.depositAboveCop?`Requiere abono de ${cop(paymentPolicy.depositCop)} y verificación antes de entrar a cocina.`:'Pago contra entrega.';
  await send('Revisa tu pedido:\n'+ctx.cart.map((l:CartLine)=>`${l.quantity} × ${menu.find(p=>p.id===l.menuItemId)?.name}`).join('\n')+`\n\nDomicilio: ${cop(ctx.quote.fee)}\nTotal: ${cop(ctx.quote.total)}\n${slot.label}\n${ctx.address}\n${payment}\n\nResponde CONFIRMAR para reservar y registrar tu pedido. NUEVO permite empezar de nuevo.`);return {step:'confirm'};
 }
 if(ctx.step==='confirm'){
  if(norm!=='confirmar'){await send('Si todo está correcto, responde CONFIRMAR. Para cambiar la selección, escribe NUEVO.');return {step:'confirm'};}
  try{
   const order=await orders.create({phone:m.phone,displayName:m.displayName,cart:ctx.cart,fulfillmentType:'delivery',windowId:ctx.windowId,deliveryAddress:ctx.address,deliveryCoverage:ctx.coverage,expectedTotalCop:ctx.quote.total,expectedMenuVersion:ctx.menuVersion,idempotencyKey:ctx.checkoutId});
   await save({...ctx,step:'done',orderId:order.orderId});await send(`${order.publicId} registrado · ${cop(order.total)}. ${order.deposit||order.fullPayment||cfg.PAYMENT_PROVIDER!=='cash_on_delivery'?order.payment.instructions:'Te avisaremos por este chat cuando cambie su estado.'}`);return {step:'done',orderId:order.orderId};
  }catch(e){const message=e instanceof Error?e.message:'';if(/Slot\.|cupo|franja|fecha.*llen/i.test(message)){await showSlots();return {step:'slot',capacityChanged:true};}await send(message||'No pudimos registrar el pedido. Tu selección está guardada.');return {step:'confirm',error:true};}
 }
 return {step:ctx.step};
}
