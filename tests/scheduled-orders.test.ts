import {parseRequestedTime} from '../src/services/scheduled-conversation.js';
import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DateTime} from 'luxon';
import {createTestDb} from '../src/db/index.js';
import {configSchema} from '../src/config.js';
import {buildRuntime as localRuntime} from '../src/runtime.js';
const buildRuntime=localRuntime;
import {publishOpeningMenu} from '../admin-dashboard/src/opening-menu.mjs';
import {compileScheduling,schedulingDecision,availableScheduledTimes,serviceTime,transitionScheduledGroup,readScheduledGroups} from '../admin-dashboard/src/scheduled-orders.mjs';
import {parseMetaMessages} from '../src/providers/whatsapp.js';
import {getRun,listRuns} from '../admin-dashboard/src/kitchen-store.mjs';
import {recordStaffPayment} from '../admin-dashboard/src/staff-payments.mjs';
const now=DateTime.fromISO('2026-11-24T10:00:00-05:00');
const fields={channel:'delivery',noticeMinutes:60,serviceOpen:true,pinConfirmed:true,nightlyCount:12,groupCount:3,driverFree:true};
it('runs the authored Onto capacity, lead-time and pin rules, including a changed rule',()=>{
 expect(schedulingDecision(fields).result.committed).toBe(true);
 for(const bad of [{noticeMinutes:59},{pinConfirmed:false},{nightlyCount:13},{groupCount:4},{driverFree:false},{serviceOpen:false}])expect(schedulingDecision({...fields,...bad}).result.committed).toBe(false);
 expect(schedulingDecision({...fields,channel:'pickup',pinConfirmed:false,nightlyCount:13,groupCount:4,driverFree:false}).result.committed).toBe(true);
 const changed=compileScheduling(readFileSync('onto/king-cajun/delivery.onto','utf8').replace('nightlyCount is at most 12','nightlyCount is at most 11'));
 expect(schedulingDecision(fields,changed).result.committed).toBe(false);
 expect(serviceTime('delivery','2026-11-26T18:30:00-05:00',now)).toBe(false);
 expect(serviceTime('pickup','2026-11-26T17:30:00-05:00',now)).toBe(true);
 expect(serviceTime('pickup','2026-11-26T17:29:00-05:00',now)).toBe(false);
 expect(serviceTime('delivery','2026-11-28T21:40:00-05:00',now)).toBe(true);
 expect(serviceTime('delivery','2026-11-28T21:41:00-05:00',now)).toBe(false);
 expect(serviceTime('delivery','2026-12-05T18:30:00-05:00',now)).toBe(false);
});
async function fixture(){const cfg=configSchema.parse({NODE_ENV:'test',OPENAI_API_KEY:'test-only',BOT_MODE:'ordering',BOT_AUDIENCE:'all',SCHEDULED_ORDERING_ENABLED:true,NEW_ORDERS_PAUSED:true,NEW_ORDERS_PAUSE_REASON:'grand_opening',NEW_ORDERS_FULL_PAYMENT:true,WHATSAPP_PROVIDER:'demo',PAYMENT_PROVIDER:'cash_on_delivery',PAYMENT_QR_IMAGE_URL:'https://example.test/assets/payments-20261124/bre-b.png',MANUAL_TRANSFER_INSTRUCTIONS:'Paga con el QR. Llave Bre-B: 0000000000'});const rt=await buildRuntime(cfg,await createTestDb());await rt.db.transaction(publishOpeningMenu);await rt.orders.loadMenu();return rt;}
const destination=(start='2026-11-28T18:30:00-05:00',area='Laureles-Estadio',point={lat:6.245,lng:-75.595})=>({kind:'delivery' as const,startsAt:start,address:'Carrera 76 #40-20, '+area+', Medellín',area,point,pinConfirmed:true});
async function checkout(rt:any,scheduled:any,key=randomUUID()){
 const item=rt.orders.menu()[0];
 return rt.orders.create({phone:'+573001234567',idempotencyKey:key,cart:[{menuItemId:item.id,quantity:1,customization:{spice:'Suave',sauce:'Salsa de la casa'}}],fulfillmentType:scheduled.kind,windowId:'scheduled',deliveryAddress:scheduled.address,fullPrepayment:true,scheduled,deliveryCoverage:{method:scheduled.kind,status:'inside',needsReview:false,preference:scheduled.kind==='pickup'?'pickup':null,policyVersion:'test',label:scheduled.area},expectedTotalCop:scheduled.kind==='delivery'?102000:87000});
}
it('atomically groups nearby orders, limits each driver interval, offers alternatives and excludes pickups',async()=>{
 const rt=await fixture();try{
  const first=await checkout(rt,destination()),second=await checkout(rt,destination());
  const options=await availableScheduledTimes(rt.db,{kind:'delivery',date:'2026-11-28',area:'Laureles-Estadio',point:{lat:6.245,lng:-75.595},pinConfirmed:true});
  expect(options[0].recommended).toBe(true);expect(options[0].startsAt).toContain('23:30');expect(options.some((o:any)=>!o.recommended)).toBe(true);
  const key=randomUUID();const third=await checkout(rt,destination(),key);expect((await checkout(rt,destination(),key)).orderId).toBe(third.orderId);
  await checkout(rt,destination('2026-11-28T18:30:00-05:00','El Poblado',{lat:6.21,lng:-75.57}));
  await expect(checkout(rt,destination())).rejects.toThrow('horario');
  await expect(checkout(rt,destination('2026-11-28T19:00:00-05:00','Belén',{lat:6.23,lng:-75.61}))).rejects.toThrow('horario');
  await checkout(rt,{kind:'pickup',startsAt:'2026-11-26T22:00:00-05:00',address:'King Cajun'});
  const groups=await readScheduledGroups(rt.db,'2026-11-28');expect(groups.nightly).toBe(4);expect(groups.groups).toHaveLength(2);
  await rt.db.query("UPDATE orders SET status='expired',payment_expires_at=now()-interval '1 minute' WHERE id=$1",[second.orderId]);
  await checkout(rt,destination());
  await expect(rt.db.query("UPDATE orders SET status='confirmed' WHERE id=$1",[second.orderId])).rejects.toThrow('3 pedidos');
  expect((await rt.db.query('SELECT * FROM scheduled_executions')).rows.length).toBe(6);
  expect(first.total).toBe(102000);
 }finally{await rt.db.close();}
},30000);
it('caps the entire night at 12 under simultaneous checkouts and refuses late payment resurrection',async()=>{
 const rt=await fixture();try{
  const requests=[];
  for(const time of ['18:00','19:15'])for(const area of ['Laureles-Estadio','El Poblado'])for(let i=0;i<3;i++)requests.push(destination(`2026-11-28T${time}:00-05:00`,area,area==='El Poblado'?{lat:6.21,lng:-75.57}:{lat:6.245,lng:-75.595}));
  for(const req of requests.slice(0,11))await checkout(rt,req);
  const results=await Promise.allSettled([checkout(rt,requests[11]),checkout(rt,requests[11])]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  await expect(checkout(rt,destination('2026-11-28T20:30:00-05:00'))).rejects.toThrow('horario');
  expect((await readScheduledGroups(rt.db,'2026-11-28')).nightly).toBe(12);
 }finally{await rt.db.close();}
},30000);
it('walks a real WhatsApp delivery through pin confirmation, review, persisted order and payment instructions',async()=>{
 const rt=await fixture();try{
  const phone='+573001234568';const say=(text='',actionId?:string,location?:any)=>rt.conversations.handle({phone,text,actionId,location,eventId:randomUUID()});
  const context=async()=>(await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0].context;
  await say('Hacer pedido','kc:place_order');await say('','kc:order:delivery');await say('3x1, 19x1');expect((await context()).step,JSON.stringify((await rt.db.query('SELECT body FROM message_outbox ORDER BY created_at DESC LIMIT 2')).rows)).toBe('address');
  await say('Calle 10 #40-20, apto 301, El Poblado, Medellín');expect((await context()).step).toBe('pin');
  await say('',undefined,{lat:6.21,lng:-75.57});expect((await context()).step).toBe('pin_confirm');
  await say('sí');expect((await context()).step).toBe('pin_confirm');
  await say('','kc:order:pin:'+(await context()).pinToken);await say('1');await say('a las 6:30 pm');expect((await context()).step).toBe('review');
  const key=(await context()).key;await say('','kc:order:confirm:'+key);expect((await context()).step).toBe('done');
  const rows=(await rt.db.query<any>('SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone_e164=$1',[phone])).rows;
  expect(rows).toHaveLength(1);expect(rows[0].total_cop).toBe(143000);expect(rows[0].status).toBe('awaiting_payment');expect(rows[0].delivery_coverage.dispatchLocation.lat).toBe(6.21);
  const out=(await rt.db.query<any>('SELECT body,buttons_json FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1',[phone])).rows;
  expect(out.some(m=>m.body.includes('google.com/maps'))).toBe(true);expect(out.some(m=>m.body.includes('pendiente de pago'))).toBe(true);expect(out.some(m=>m.body.includes('6:30')&&m.body.includes('6:50'))).toBe(true);expect((await rt.db.query("SELECT media_url FROM message_outbox WHERE kind='payment_qr'")).rows).toEqual([{media_url:'https://example.test/assets/payments-20261124/bre-b.png'}]);expect(out.every(m=>!m.buttons_json||m.body.length<=1024)).toBe(true);
 }finally{await rt.db.close();}
},30000);
it('preserves native WhatsApp location coordinates',()=>{
 const msgs=parseMetaMessages({entry:[{changes:[{field:'messages',value:{messages:[{id:'loc1',from:'573001234568',type:'location',location:{latitude:6.21,longitude:-75.57}}]}}]}]});expect(msgs[0].location).toMatchObject({lat:6.21,lng:-75.57});
});
it('supports pickup without a map or driver, and a human request exits the draft',async()=>{
 const rt=await fixture();try{
  const phone='+573001234569';const say=(text='',actionId?:string)=>rt.conversations.handle({phone,text,actionId,eventId:randomUUID()});
  const context=async()=>(await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0]?.context;
  await say('','kc:place_order');await say('','kc:order:pickup');await say('1x1');expect((await context()).step).toBe('date');await say('1');await say('7:30 pm');const c=await context();await say('','kc:order:confirm:'+c.key);
  expect((await context()).step).toBe('done');const o=(await rt.db.query<any>('SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone_e164=$1',[phone])).rows[0];expect(o.total_cop).toBe(87000);expect(o.delivery_fee_cop).toBe(0);expect(o.delivery_coverage.method).toBe('pickup');expect(o.delivery_coverage.pickupArrival).toBeTruthy();expect((await rt.db.query('SELECT * FROM scheduled_groups')).rows).toHaveLength(0);
  await say('','kc:place_order');await say('','kc:human');expect(await context()).toBeUndefined();
 }finally{await rt.db.close();}
},30000);
it('requires paid, ready orders and a returned driver before the next departure',async()=>{
 const rt=await fixture();try{
  const a=await checkout(rt,destination()),b=await checkout(rt,destination('2026-11-28T19:45:00-05:00'));
  const rows=(await rt.db.query<any>('SELECT * FROM scheduled_groups ORDER BY starts_at')).rows;
  await rt.db.query("UPDATE scheduled_groups SET starts_at=now()-interval '1 minute'");
  const actor={id:'admin:test',roles:['Dispatcher']};
  await expect(transitionScheduledGroup(rt.db,rows[0].id,'dispatch',{id:'customer',roles:[]},true)).rejects.toThrow('autorizado');
  await expect(transitionScheduledGroup(rt.db,rows[0].id,'dispatch',actor,true)).rejects.toThrow('pago');
  await rt.db.query("UPDATE orders SET status='confirmed' WHERE id=ANY($1::uuid[])",[[a.orderId,b.orderId]]);await rt.db.query("UPDATE payments SET status='confirmed' WHERE order_id=ANY($1::uuid[])",[[a.orderId,b.orderId]]);
  await expect(transitionScheduledGroup(rt.db,rows[0].id,'dispatch',actor,false)).rejects.toThrow('preparación');
  await transitionScheduledGroup(rt.db,rows[0].id,'dispatch',actor,true);
  await expect(transitionScheduledGroup(rt.db,rows[1].id,'dispatch',actor,true)).rejects.toThrow('conductor');
  await transitionScheduledGroup(rt.db,rows[0].id,'return',actor);
  expect((await transitionScheduledGroup(rt.db,rows[1].id,'dispatch',actor,true)).state).toBe('out');
 }finally{await rt.db.close();}
},30000);
it('imports the paid order into the original kitchen with the frozen current-menu counts',async()=>{
 const rt=await fixture();try{
  await rt.db.exec(readFileSync('admin-dashboard/kitchen-migrations.sql','utf8'));
  const o=await checkout(rt,{kind:'pickup',startsAt:'2026-11-26T22:00:00-05:00',address:'King Cajun'});
  await rt.db.transaction(tx=>recordStaffPayment(tx,o.orderId,{eventId:'test-paid-'+randomUUID(),phone:'+573001234567',sentAt:new Date().toISOString()},{totalPaidCop:87000,previousPaidCop:0,basis:'test',keys:[],evidenceIds:['test'],summary:'Test fixture payment'}));
  const runs=await listRuns(rt.db),run=runs.find((r:any)=>r.date==='2026-11-26');const kitchen=await getRun(rt.db,run.id);
  const imported=kitchen.document.orders.find((x:any)=>x.sourceOrderId===o.orderId);expect(imported).toBeTruthy();expect(imported.deliveryCoverage.method).toBe('pickup');expect(imported.totalCop).toBe(87000);
  const lines=(await rt.db.query<any>('SELECT kitchen_snapshot_json FROM order_line_items WHERE order_id=$1',[o.orderId])).rows;expect(lines[0].kitchen_snapshot_json.product.components.find((c:any)=>c.ingredientId==='opening_shrimp').quantity).toBe(15);
 }finally{await rt.db.close();}
},30000);

it('understands customer-written times without interpreting them as menu positions',()=>{
 for(const text of ['6:30','6:30 pm','a las 6:30 p. m.','seis y media','18:30'])expect(parseRequestedTime(text,'2026-11-28')).toBe('2026-11-28T23:30:00.000Z');
 expect(parseRequestedTime('6:99','2026-11-28')).toBeNull();expect(parseRequestedTime('mañana','2026-11-28')).toBeNull();
});

it('suggests one nearby group but lets the customer keep their requested time',async()=>{
 const rt=await fixture();try{
  await checkout(rt,destination('2026-11-28T18:30:00-05:00','El Poblado',{lat:6.21,lng:-75.57}));
  const phone='+573001234570';const say=(text='',actionId?:string,location?:any)=>rt.conversations.handle({phone,text,actionId,location,eventId:randomUUID()});
  const context=async()=>(await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0].context;
  await say('','kc:place_order');await say('','kc:order:delivery');await say('1x1');await say('Calle 10 #40-20, El Poblado, Medellín');await say('',undefined,{lat:6.21,lng:-75.57});await say('','kc:order:pin:'+(await context()).pinToken);await say('1');
  const prompt=(await rt.db.query<any>("SELECT body FROM message_outbox WHERE kind='scheduled_order_flow' ORDER BY created_at DESC LIMIT 1")).rows[0].body;
  expect(prompt).toContain('¿A qué hora');expect(prompt).not.toContain('1.');expect(prompt).toContain('15–20');
  await say('7:07 pm');const c=await context();expect(c.timeOffers).toHaveLength(2);expect(c.timeOffers[0].recommended).toBe(true);expect(c.timeOffers[1].startsAt).toContain('00:07');
  await say('',`kc:order:time:${c.timeOfferToken}:1`);expect((await context()).step).toBe('review');expect((await context()).startsAt).toContain('00:07');
 }finally{await rt.db.close();}
},30000);

it('sends the two approved menu images and accepts a named cart while keeping prices server-owned',async()=>{const rt=await fixture();try{
 const phone='+573001234599',say=(text='',actionId?:string)=>rt.conversations.handle({phone,text,actionId,eventId:randomUUID()});const context=async()=>(await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0].context;
 await say('','kc:place_order');await say('','kc:order:pickup');const images=(await rt.db.query<any>("SELECT media_url FROM message_outbox WHERE kind IN ('menu_image','menu_extras_image') ORDER BY created_at")).rows;expect(images.map(x=>x.media_url)).toEqual(['/assets/responses-20261122/menu-combos.png','/assets/responses-20261122/menu-build.png']);const bodies=(await rt.db.query<any>('SELECT body FROM message_outbox')).rows.map(x=>x.body);expect(bodies.some(x=>x.includes('Escribe los nombres y cantidades'))).toBe(true);expect(bodies.some(x=>x.includes('1x2')||x.includes('20. Agua'))).toBe(false);
 const shrimp=rt.orders.menu().find((i:any)=>i.sku==='KC-20261122-personal-shrimp')!,water=rt.orders.menu().find((i:any)=>i.sku==='KC-20261122-water')!;
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'function_call',name:'select_menu_items',arguments:JSON.stringify({items:[{id:shrimp.id,quantity:1},{id:water.id,quantity:2}],clarification:null})}]})})));
 await say('un combo personal de 15 langostinos y dos aguas');expect((await context()).step).toBe('date');expect((await context()).subtotal).toBe(105000);expect((await context()).cart).toHaveLength(2);
 await say('1');await say('7:30 pm');await say('','kc:order:confirm:'+(await context()).key);expect((await rt.db.query<any>('SELECT total_cop,status FROM orders')).rows[0]).toMatchObject({total_cop:105000,status:'awaiting_payment'});
}finally{vi.unstubAllGlobals();await rt.db.close();}},30000);
it('retains an ambiguous selection for clarification and rejects made-up menu IDs',async()=>{const rt=await fixture();try{
 const phone='+573001234598',say=(text='',actionId?:string)=>rt.conversations.handle({phone,text,actionId,eventId:randomUUID()});await say('','kc:place_order');await say('','kc:order:pickup');
 const reply=(items:any[],clarification:string|null)=>({ok:true,json:async()=>({status:'completed',output:[{type:'function_call',name:'select_menu_items',arguments:JSON.stringify({items,clarification})}]})});const fake=vi.fn().mockResolvedValueOnce(reply([],'¿Quieres el personal de langostinos, mejillones o cangrejo de nieve?')).mockResolvedValueOnce(reply([{id:'invented-id',quantity:1}],null));vi.stubGlobal('fetch',fake);
 await say('dos personales y un agua');let c=(await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0].context;expect(c.step).toBe('cart');expect(c.cartMessages[0].text).toBe('dos personales y un agua');await say('de langostinos');expect(JSON.parse(fake.mock.calls[1][1].body).input[0].content).toContain('dos personales y un agua');expect((await rt.db.query('SELECT * FROM orders')).rows).toHaveLength(0);expect((await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0].context.step).toBe('cart');
}finally{vi.unstubAllGlobals();await rt.db.close();}},30000);

it('opens partially filled groups independently and blocks each driver for exactly 75 minutes',async()=>{const rt=await fixture();try{
 await checkout(rt,destination('2026-11-28T18:00:00-05:00'));await checkout(rt,destination('2026-11-28T18:30:00-05:00','El Poblado',{lat:6.21,lng:-75.57}));
 await expect(checkout(rt,destination('2026-11-28T19:14:00-05:00','Belén',{lat:6.23,lng:-75.61}))).rejects.toThrow('horario');
 await checkout(rt,destination('2026-11-28T19:15:00-05:00','Belén',{lat:6.23,lng:-75.61}));
 await expect(checkout(rt,destination('2026-11-28T19:44:00-05:00','Envigado',{lat:6.17,lng:-75.58}))).rejects.toThrow('horario');
 await checkout(rt,destination('2026-11-28T19:45:00-05:00','Envigado',{lat:6.17,lng:-75.58}));
 const g=(await readScheduledGroups(rt.db,'2026-11-28')).groups;expect(g.map((x:any)=>x.driver)).toEqual([1,2,1,2]);expect(g.every((x:any)=>x.orders.length===1&&+new Date(x.ends_at)-+new Date(x.starts_at)===75*60000)).toBe(true);
}finally{await rt.db.close();}},30000);
it('allows another group in a full group’s area when the second driver is free',async()=>{const rt=await fixture();try{for(let i=0;i<4;i++)await checkout(rt,destination('2026-11-28T18:00:00-05:00'));const g=(await readScheduledGroups(rt.db,'2026-11-28')).groups;expect(g.map((x:any)=>x.orders.length).sort()).toEqual([1,3]);expect(new Set(g.map((x:any)=>x.driver)).size).toBe(2);}finally{await rt.db.close();}},30000);

it('shows three welcome options, sends both menu images and resumes ordering after a temporary pause',async()=>{
 const rt=await fixture(),phone='+573009876543';
 try{
  const send=(text:string,actionId?:string)=>rt.conversations.handle({phone,text,actionId,eventId:randomUUID()});
  await send('Hola');
  const welcome=(await rt.db.query<any>("SELECT buttons_json FROM message_outbox WHERE kind='grand_opening_notice'")).rows[0];
  expect(welcome.buttons_json.map((b:any)=>b.id)).toEqual(['kc:place_order','kc:view_menu','kc:human']);
  await send('Ver menú','kc:view_menu');
  const images=(await rt.db.query<any>("SELECT media_url FROM message_outbox WHERE kind IN ('menu_image','menu_extras_image') AND status='sent'")).rows;
  expect(images).toHaveLength(2);
  await rt.db.query("INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,updated_at,updated_by) VALUES($1,now()+interval '30 minutes',now(),'test-temporary')",[phone]);
  expect(await send('Hacer pedido','kc:place_order')).toMatchObject({scheduled:true});
  expect((await rt.db.query<any>('SELECT context FROM scheduled_chats WHERE phone=$1',[phone])).rows[0].context.step).toBe('method');
  expect((await rt.db.query<any>("SELECT buttons_json FROM message_outbox WHERE kind='scheduled_order_flow' AND status='sent'")).rows[0].buttons_json.map((b:any)=>b.id)).toEqual(['kc:order:delivery','kc:order:pickup','kc:human']);
  await rt.db.query('UPDATE whatsapp_chat_controls SET manual_paused_at=now() WHERE customer_phone=$1',[phone]);
  expect(await send('Hacer pedido','kc:place_order')).toMatchObject({mode:'staff_paused',replied:false});
 }finally{await rt.db.close();}
},30000);
