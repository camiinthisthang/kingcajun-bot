import {readScheduledCart} from './scheduled-cart.js';
import {requestBankMailCheck} from '../../admin-dashboard/src/bank-mail.mjs';
import {randomUUID} from 'node:crypto';
import {DateTime} from 'luxon';
import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import type {InboundMessage} from '../types.js';
import type {OrderService} from './orders.js';
import type {MessagingService} from './messaging.js';
import {availableScheduledTimes,serviceDates,validPoint,ZONE,policy} from '../../admin-dashboard/src/scheduled-orders.mjs';
import {coordinatePair,googleMapsUrl,pointFromGoogleUrl} from '../../admin-dashboard/public/location-utils.js';
import {isChatPaused} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {coverageSnapshot,locationFromAddress} from './delivery-coverage.js';
import {asksRestaurantLocation,asksRestaurantHours,restaurantAddress,responseImages} from './restaurant-information.js';
import {orderingPauseReply} from './ordering-pause.js';
import {cop,normalizeText} from '../lib/format.js';

const human={id:'kc:human',title:'Hablar con alguien'};
const methods=[{id:'kc:order:delivery',title:'Domicilio'},{id:'kc:order:pickup',title:'Recoger en el local'},human];
const dateLabel=(s:string)=>DateTime.fromISO(s,{zone:ZONE}).setLocale('es-CO').toFormat("cccc d 'de' LLLL");
const timeLabel=(s:string)=>DateTime.fromISO(s).setZone(ZONE).setLocale('es-CO').toFormat('h:mm a');
function promiseLabel(c:any){return c.kind==='delivery'?`${dateLabel(c.startsAt)} · ${timeLabel(c.startsAt)}–${timeLabel(DateTime.fromISO(c.startsAt).plus({minutes:policy.arrivalMinutes}).toISO()!)}`:`${dateLabel(c.startsAt)} a las ${timeLabel(c.startsAt)}`;}

export function parseRequestedTime(value:string,date:string):string|null{
 let t=value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[.]/g,'').replace(/\bp\s+m\b/g,'pm').replace(/\ba\s+m\b/g,'am').trim();
 const words:Record<string,string>={cuatro:'4',cinco:'5',seis:'6',siete:'7',ocho:'8',nueve:'9',diez:'10'};
 t=t.replace(/\b(cuatro|cinco|seis|siete|ocho|nueve|diez)\b/g,w=>words[w]!).replace(/\s+y media\b/g,':30').replace(/\s+y cuarto\b/g,':15');
 const m=t.match(/^(?:(?:a|para|sobre)\s+(?:las?\s+)?)?(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|de la tarde|de la noche|de la manana)?(?:\s*(?:por favor|porfa))?$/);
 if(!m)return null;let hour=Number(m[1]),minute=Number(m[2]??0);if(minute>59||hour>23)return null;
 if(m[3]){if(hour<1||hour>12)return null;if(['pm','de la tarde','de la noche'].includes(m[3]))hour=hour%12+12;else hour=hour%12;}
 else if(hour>=1&&hour<=10)hour+=12;
 const at=DateTime.fromISO(date,{zone:ZONE}).set({hour,minute,second:0,millisecond:0});return at.isValid?at.toUTC().toISO():null;
}

/** Explicit entry point. FAQ messages and human takeover continue through the existing router. */
export async function handleScheduledConversation(db:Db,cfg:Config,orders:OrderService,messaging:MessagingService,message:InboundMessage,action:string|null|undefined):Promise<any>{
 if(!cfg.SCHEDULED_ORDERING_ENABLED)return null;
 let c:any=(await db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[message.phone])).rows[0]?.context;
 const text=normalizeText(message.text).trim(),cartText=message.text.trim().toLowerCase();
 const save=()=>db.query('INSERT INTO scheduled_chats(phone,context) VALUES($1,$2::jsonb) ON CONFLICT(phone) DO UPDATE SET context=excluded.context,updated_at=now()',[message.phone,JSON.stringify(c)]);
 const clear=()=>db.query('DELETE FROM scheduled_chats WHERE phone=$1',[message.phone]);
 const say=async(body:string,buttons:any[]=[human])=>{
  if(body.length>1000){await messaging.sendNow(message.phone,body,'scheduled_order_flow');return messaging.sendButtonsNow(message.phone,'Puedes continuar con tu pedido o pedir ayuda al equipo.',buttons,'scheduled_order_flow');}
  return messaging.sendButtonsNow(message.phone,body,buttons,'scheduled_order_flow');
 };
 if(action==='human'){await clear();return null;}
 if(action==='catalog'||asksRestaurantLocation(message.text)||asksRestaurantHours(message.text))return null;
 const entering=action==='order'||message.actionId==='kc:place_order';
 if(!entering&&!c&&cfg.BANK_MAIL_ENABLED&&message.media&&!(await isChatPaused(db,message.phone))){
  const check=await requestBankMailCheck(db,{phone:message.phone,publicId:null,receiptId:message.media.id});
  if(check.status!=='not_applicable'){await say(check.status==='pending'?'Recibí tu comprobante. Voy a verificar el pago con el banco y te aviso cuando esté confirmado.':'Recibí el comprobante. El equipo debe revisar a qué pedido corresponde y verificar el pago.');return {scheduled:true};}
 }
 if(!entering&&!c)return null;
 if(await isChatPaused(db,message.phone))return {mode:'staff_paused',replied:false};
 if(cfg.NEW_ORDERS_PAUSED&&cfg.NEW_ORDERS_PAUSE_REASON!=='grand_opening'){await say(orderingPauseReply(cfg));return {scheduled:true};}
 if(text==='salir'||text==='cancelar pedido nuevo'){await clear();await say('Cerré este borrador. No se creó ningún pedido. Los pedidos ya registrados no cambian.');return {scheduled:true};}
 if(entering){c={step:'method',key:randomUUID()};await save();await say('Soy el asistente virtual de King Cajun. 🦀 ¿Cómo quieres recibir tu pedido?\n\nRecogida: jueves a domingo en horario de apertura.\nDomicilios: sábados y domingos, 6–10 p. m.\nPide con al menos 60 minutos de anticipación.',methods);return {scheduled:true};}
 await orders.loadMenu();const catalog=orders.menu();
 // Never silently sell a stale costing catalog through this new workflow.
 const menu=catalog.filter((i:any)=>JSON.parse(i.metadata_json||'{}').scheduledMenu==='2026-11-22');
 if(menu.length!==20){await say('El equipo está actualizando el menú para pedidos. Toca «Hablar con alguien» y te ayudamos.');return {scheduled:true};}
 const showMenu=async()=>{
  c.step='cart';c.menuIds=menu.map((i:any)=>i.id);c.cartMessages=[];await save();
  const imageUrl=(path:string)=>cfg.WHATSAPP_PROVIDER==='demo'?path:cfg.PUBLIC_BASE_URL.replace(/\/$/,'')+path;
  await messaging.sendImageNow(message.phone,imageUrl(responseImages.combos),'Combos King Cajun · precios en COP.','menu_image');
  await messaging.sendImageNow(message.phone,imageUrl(responseImages.build),'Arma tu propio boil · precios en COP.','menu_extras_image');
  await say('¿Qué te gustaría pedir? Escribe los nombres y cantidades, por ejemplo: «1 combo personal de 15 langostinos y 2 aguas».');
 };
 const showDates=async()=>{c.dates=serviceDates(c.kind);c.step='date';await save();await say(c.dates.length?'¿Para qué día?\n'+c.dates.map((d:string,i:number)=>`${i+1}. ${dateLabel(d)}`).join('\n')+'\nResponde con el número. Abrimos pedidos de cada semana los lunes.':'No quedan fechas esta semana. Abrimos los pedidos de la próxima semana el lunes.',[human]);};
 const showTimes=async()=>{
  c.step='time';c.timeInput='free';delete c.timeOffers;await save();
  await say(c.kind==='delivery'?'¿A qué hora quieres recibir tu domicilio? Entregamos de 6 a 10 p. m.; cuenta con un margen de 15–20 minutos después de la hora elegida. Por ejemplo: 6:30 p. m.':'¿A qué hora quieres recoger tu pedido? Por ejemplo: 7:30 p. m.',[{id:'kc:order:dates',title:'Cambiar día'},human]);
 };
 const reviewTime=async(startsAt:string)=>{
  c.startsAt=startsAt;c.total=c.subtotal+(c.kind==='delivery'?15000:0);c.menuVersion=orders.menuVersion();c.step='review';await save();
  await say(`Revisa tu pedido:\n${c.summary}\n\n${c.kind==='delivery'?'Domicilio: $15.000':'Recogida: sin costo de domicilio'}\n*Total: ${cop(c.total)}*\n📍 ${c.address}\n🕒 ${promiseLabel(c)}\n\nAl confirmar reservamos el cupo por 15 minutos. El pedido queda confirmado cuando el equipo verifica el pago completo.`,[{id:'kc:order:confirm:'+c.key,title:'Confirmar pedido'},{id:'kc:order:edit',title:'Cambiar productos'},human]);
 };
 const offerTimes=async(body:string,options:any[])=>{
  c.timeOffers=options.slice(0,2);c.timeOfferToken=randomUUID().slice(0,8);await save();
  await say(body,[...c.timeOffers.map((o:any,i:number)=>({id:`kc:order:time:${c.timeOfferToken}:${i}`,title:timeLabel(o.startsAt)})),human]);
 };
 try{
  if(message.actionId==='kc:order:dates'&&c.kind&&c.cart){await showDates();return {scheduled:true};}
  if(message.actionId==='kc:order:pickup'&&c.cart){c.kind='pickup';c.address=restaurantAddress;delete c.point;delete c.pinConfirmed;await showDates();return {scheduled:true};}
  if(c.step==='method'){
   if(message.actionId==='kc:order:delivery'||text==='domicilio')c.kind='delivery';
   else if(message.actionId==='kc:order:pickup'||/^(recoger|recogida|pickup)$/.test(text))c.kind='pickup';
   else{await say('Elige «Domicilio» o «Recoger en el local».',methods);return {scheduled:true};}
   await showMenu();
  }else if(c.step==='cart'){
   const quantities=new Map<string,number>();
   if(/^\d+\s*x\s*\d+(?:\s*,\s*\d+\s*x\s*\d+)*$/i.test(cartText)){
    // Preserve old numbered replies already sent before the image-menu change.
    for(const part of cartText.split(',')){const [n,q]=part.split('x').map(Number);const id=c.menuIds[n!-1];if(!id||!q||q>20)throw Error('Revisa los productos y sus cantidades (1–20).');quantities.set(id,(quantities.get(id)??0)+q);}
   }else{
    const messages=[...(c.cartMessages??[]),{role:'customer',text:message.text.slice(0,2000)}].slice(-10);
    const parsed=await readScheduledCart(cfg,menu,messages);
    if(parsed.clarification){c.cartMessages=[...messages,{role:'assistant',text:parsed.clarification}].slice(-10);await save();await say(parsed.clarification);return {scheduled:true};}
    if(!parsed.items.length){await say('Dime qué productos quieres y cuántos de cada uno.');return {scheduled:true};}
    for(const item of parsed.items)quantities.set(item.id,(quantities.get(item.id)??0)+item.quantity);
    c.cartMessages=messages;
   }
   if([...quantities.values()].some(q=>q>20))throw Error('La cantidad máxima por producto es 20.');
   c.cart=[...quantities].map(([menuItemId,quantity])=>({menuItemId,quantity,customization:{spice:'Suave',sauce:'Salsa de la casa'}}));
   const selected=menu.filter((i:any)=>quantities.has(i.id));
   if(selected.some((i:any)=>i.sku==='KC-20261122-king-addon')&&!selected.some((i:any)=>JSON.parse(i.metadata_json).product_type==='set'))throw Error('La pata de cangrejo rey de $250.000 es un adicional para un combo. Agrega un combo o elige la pata individual de $252.000.');
   if(!selected.some((i:any)=>i.category==='plate'))throw Error('Agrega al menos un plato a tu pedido.');
   c.summary=c.cart.map((l:any)=>{const i:any=menu.find((i:any)=>i.id===l.menuItemId);return `${l.quantity} × ${i.name} — ${cop(i.price_cop*l.quantity)}`;}).join('\n');
   c.subtotal=c.cart.reduce((sum:number,l:any)=>sum+(menu.find((i:any)=>i.id===l.menuItemId) as any).price_cop*l.quantity,0);
   if(c.kind==='pickup'){c.address=restaurantAddress;await showDates();}
   else{c.step='address';await save();await say('Escribe la dirección completa, apartamento o local y barrio/comuna. Ejemplo: Calle 10 #40-20, apto 301, El Poblado, Medellín.\n\nDomicilio: $15.000 dentro de nuestra zona. Después confirmaremos el punto en Google Maps.');}
  }else if(c.step==='address'){
   if(message.text.trim().length<10||message.text.length>500)throw Error('Escribe la dirección completa, apartamento o local y barrio/comuna.');
   const coverage=coverageSnapshot(locationFromAddress(message.text));
   if(coverage.status!=='inside'){await say('No puedo confirmar que esa dirección esté dentro de nuestra zona. Puedes elegir recogida o pedirle al equipo que revise la cobertura.',[{id:'kc:order:pickup',title:'Elegir recogida'},human]);return {scheduled:true};}
   c.address=message.text.trim();c.coverage=coverage;c.area=coverage.label;c.step='pin';delete c.point;delete c.pinConfirmed;await save();
   await say('Ahora envía la ubicación exacta usando 📎 o + → Ubicación en WhatsApp. También puedes pegar coordenadas o un enlace de Google Maps que incluya el pin. Así agrupamos tu pedido con direcciones cercanas.');
  }else if(c.step==='pin'){
   let point:any=message.location??coordinatePair(message.text);const url=googleMapsUrl(message.text);if(!point&&url)point=pointFromGoogleUrl(url);
   if(!validPoint(point)){await say('Necesito el pin exacto. Envía tu ubicación con 📎 o + → Ubicación, o copia las coordenadas de Google Maps. Un enlace corto o una dirección escrita no permite ubicar el punto con certeza.');return {scheduled:true};}
   c.point={lat:point.lat,lng:point.lng};c.step='pin_confirm';c.pinToken=randomUUID().slice(0,8);await save();
   await say(`¿Esta es la ubicación correcta para ${c.address}?\nhttps://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}\n\nAbre el mapa y confirma el pin antes de seguir.`,[{id:'kc:order:pin:'+c.pinToken,title:'Sí, es correcto'},{id:'kc:order:fixpin',title:'Corregir ubicación'},human]);
  }else if(c.step==='pin_confirm'){
   if(message.actionId==='kc:order:fixpin'){c.step='address';delete c.point;delete c.pinConfirmed;await save();await say('Escribe nuevamente la dirección completa y el barrio/comuna.');}
   else if(message.actionId==='kc:order:pin:'+c.pinToken){c.pinConfirmed=true;await showDates();}
   else await say('Confirma el pin con «Sí, es correcto» en el mensaje del mapa o toca «Corregir ubicación».');
  }else if(c.step==='date'){
   const day=c.dates[Number(text)-1];if(!/^\d+$/.test(text)||!day)throw Error('Elige uno de los días de la lista usando su número.');c.date=day;await showTimes();
  }else if(c.step==='time'){
   const selected=c.timeOffers?.find((_:any,i:number)=>message.actionId===`kc:order:time:${c.timeOfferToken}:${i}`);
   // Older, already-sent numbered menus remain usable until the customer selects a time.
   const legacy=c.timeInput!=='free'&&/^\d+$/.test(text)?c.options?.[Number(text)-1]:null;
   const requested=selected?.startsAt??legacy?.startsAt??parseRequestedTime(message.text,c.date);
   if(!requested){await say('Dime la hora que prefieres, por ejemplo: 6:30 p. m.');return {scheduled:true};}
   c.timeInput='free';
   const options=await availableScheduledTimes(db,{kind:c.kind,date:c.date,area:c.area,point:c.point,pinConfirmed:c.pinConfirmed,requestedAt:requested});
   const exact=options.find((o:any)=>DateTime.fromISO(o.startsAt).toMillis()===DateTime.fromISO(requested).toMillis());
   const near=options.filter((o:any)=>DateTime.fromISO(o.startsAt).toMillis()!==DateTime.fromISO(requested).toMillis()).sort((a:any,b:any)=>Math.abs(DateTime.fromISO(a.startsAt).diff(DateTime.fromISO(requested),'minutes').minutes)-Math.abs(DateTime.fromISO(b.startsAt).diff(DateTime.fromISO(requested),'minutes').minutes));
   if(!exact){
    if(!near.length){await say('Ese día ya no tiene cupos disponibles. Puedes cambiar de día o elegir recogida.',[{id:'kc:order:dates',title:'Cambiar día'},{id:'kc:order:pickup',title:'Elegir recogida'},human]);return {scheduled:true};}
    await offerTimes('Esa hora no está disponible. Estas son las dos opciones más cercanas; toca una o escribe otra hora.',near);return {scheduled:true};
   }
   const grouped=near.find((o:any)=>o.recommended&&Math.abs(DateTime.fromISO(o.startsAt).diff(DateTime.fromISO(requested),'minutes').minutes)<=60);
   if(!selected&&!legacy&&grouped&&!exact.recommended){await offerTimes(`Ya tenemos una ruta por tu zona a las ${timeLabel(grouped.startsAt!)}. ¿Te sirve? También puedes mantener las ${timeLabel(exact.startsAt!)}.`,[grouped,exact]);return {scheduled:true};}
   await reviewTime(exact.startsAt!);
  }else if(c.step==='review'||c.step==='payer'){
   if(message.actionId==='kc:order:edit'){await showMenu();return {scheduled:true};}
   if(c.step==='review'&&message.actionId!=='kc:order:confirm:'+c.key){await say('Toca «Confirmar pedido» en el resumen o «Cambiar productos». Todavía no hemos creado tu pedido.');return {scheduled:true};}
   if(cfg.BANK_MAIL_ENABLED&&!c.payerName){
    if(c.step==='review'){c.step='payer';await save();await say('¿A nombre de quién harás el pago? Escribe el nombre completo del titular para verificarlo con la notificación del banco.');return {scheduled:true};}
    const payer=message.text.trim();if(!/^[\p{L}][\p{L} .'-]{3,119}$/u.test(payer)||payer.split(/\s+/).length<2){await say('Escribe el nombre y apellido del titular que hará el pago.');return {scheduled:true};}c.payerName=payer;
   }
   const coverage:any=c.kind==='pickup'?{...coverageSnapshot({municipality:null,area:null},'pickup'),pickupArrival:{estimatedAt:c.startsAt,localTime:DateTime.fromISO(c.startsAt).setZone(ZONE).toFormat('HH:mm'),timeZone:ZONE}}:{...c.coverage,method:'delivery',dispatchLocation:{...c.point,source:'customer_confirmed',sourceAddress:c.address,revision:c.key,updatedAt:new Date().toISOString()},locationConfirmation:{status:'confirmed',at:new Date().toISOString(),pointRevision:c.key}};
   if(c.payerName)coverage.paymentPayerName=c.payerName;
   try{
    const result=await orders.create({phone:message.phone,displayName:message.displayName,idempotencyKey:c.key,cart:c.cart,fulfillmentType:c.kind,windowId:'scheduled',deliveryAddress:c.address,deliveryCoverage:coverage,fullPrepayment:true,expectedTotalCop:c.total,expectedMenuVersion:c.menuVersion,scheduled:{kind:c.kind,startsAt:c.startsAt,address:c.address,area:c.area,point:c.point,pinConfirmed:c.pinConfirmed}});
    c.step='done';c.publicId=result.publicId;c.payment=result.payment.instructions;await save();
    await say(`🦀 Pedido ${result.publicId} registrado, pendiente de pago.\n${c.summary}\n\n${c.kind==='pickup'?'Recogida':'Domicilio'}: ${promiseLabel(c)}\n📍 ${c.address}\nTotal: ${cop(result.total)}\n\n${result.payment.instructions}\n\nEnvía el comprobante por este chat. El equipo debe verificarlo; una foto no confirma el pago automáticamente. Tu reserva vence a las ${timeLabel(result.expiresAt)}.`,[human]);
   }catch(error){if(c.publicId){c.step='done';await save();throw error;}if((error as any)?.code==='reservation_expired')c.key=randomUUID();c.step='time';await save();await say(error instanceof Error?error.message:'No se pudo reservar. Revisa la disponibilidad.');await showTimes();}
  }else if(c.step==='done'){
   if(message.media){
    const check=cfg.BANK_MAIL_ENABLED?await requestBankMailCheck(db,{phone:message.phone,publicId:c.publicId,receiptId:message.media.id}):null;
    await say(check?.status==='pending'?`Recibí tu comprobante para ${c.publicId}. Voy a verificar el pago con el banco y te aviso cuando esté confirmado.`:check?.status==='matched'?`El pago de ${c.publicId} ya está confirmado.`:`Recibí el comprobante para ${c.publicId}. El equipo debe verificarlo antes de confirmar el pago. Si necesitas ayuda, toca «Hablar con alguien».`);return {scheduled:true};
   }
   if(message.actionId?.startsWith('kc:order:confirm:')){await say(`Tu pedido ${c.publicId} ya está registrado. No creé otro. Para revisar el pago o cambiarlo, toca «Hablar con alguien».`);return {scheduled:true};}
   return null;
  }
 }catch(error){await say(error instanceof Error?error.message:'No pude completar ese paso. Toca «Hablar con alguien» para recibir ayuda.');}
 return {scheduled:true};
}
