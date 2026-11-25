import {afterEach,describe,expect,it,vi} from 'vitest';
import {asksRestaurantLocation,asksAmbiguousMap,responseImages} from '../src/services/restaurant-information.js';
import {coverageQuestionReply,assessDeliveryCoverage} from '../src/services/delivery-coverage.js';
import {createTestDb,type Db} from '../src/db/index.js';
import {configSchema} from '../src/config.js';
import {buildRuntime} from '../src/runtime.js';
const dbs:Db[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dbs.splice(0).map(db=>db.close()));});
describe('physical restaurant versus delivery destinations',()=>{
 it.each(['dirección','ubicación','local','¿Dónde quedan?','¿Tienen local físico?','Me mandas el mapa del restaurante','Dónde puedo recoger','¿Cómo llego?','Cual es su dirección','Quiero ir al local','¿Dónde están ubicados?'])('recognizes %s even when AI calls it coverage',(text)=>{expect(asksRestaurantLocation(text)).toBe(true);expect(coverageQuestionReply(text,{municipality:null,area:null})).toBeNull();});
 it.each(['Mi dirección es Calle 10 #43-20','Mi ubicación está mal','cambiar la dirección','vivo en Envigado','mapa de domicilios','¿Llegan a Laureles?','¿Tienen domicilio?'])('does not treat %s as restaurant location',text=>expect(asksRestaurantLocation(text)).toBe(false));
 it('asks which map when unspecified',()=>{expect(asksAmbiguousMap('Me pasas el mapa')).toBe(true);expect(coverageQuestionReply('Me pasas el mapa')).toBeNull();expect(coverageQuestionReply('mapa de domicilios')).toBeTruthy();});
 it('uses only the six areas shown in the new delivery map',()=>{for(const area of ['Laureles-Estadio','La Candelaria','Belén','Guayabal','El Poblado'])expect(assessDeliveryCoverage({municipality:'Medellín',area}).status).toBe('inside');for(const area of ['Buenos Aires','Villa Hermosa','La América'])expect(assessDeliveryCoverage({municipality:'Medellín',area}).status).toBe('outside');});
});
it('routes real inbound questions during opening pause without starting orders or sending unrelated images',async()=>{
 const db=await createTestDb();dbs.push(db);
 const cfg=configSchema.parse({NODE_ENV:'test',BOT_MODE:'ordering',WHATSAPP_PROVIDER:'demo',PAYMENT_PROVIDER:'cash_on_delivery',NEW_ORDERS_PAUSED:true,NEW_ORDERS_PAUSE_REASON:'grand_opening',MENU_IMAGE_URL:'https://old.example/menu.jpg',MENU_GUIDE_IMAGE_URL:'https://old.example/guide.jpg',FAST_CHECKOUT_ENABLED:true});
 const r=await buildRuntime(cfg,db);let n=0;
 const send=async(text:string,actionId?:string)=>{const phone='+57300001'+String(++n).padStart(4,'0');await r.conversations.handle({phone,text,actionId,eventId:crypto.randomUUID()});return(await db.query<any>('SELECT m.kind,m.body,m.media_url FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 ORDER BY m.created_at',[phone])).rows;};
 for(const text of ['dirección','ubicación','local','¿Dónde queda el restaurante?']){const rows=await send(text);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({kind:'restaurant_location',media_url:responseImages.location});expect(rows[0].body).toContain('Calle 3S #43A-40');}
 const hours=await send('Qué horario tienen');expect(hours).toHaveLength(1);expect(hours[0].media_url).toBe(responseImages.hours);expect(hours[0].body).toContain('5:30');
 const menu=await send('Ver menú','kc:view_menu');expect(menu.map(m=>m.media_url)).toEqual([responseImages.combos,responseImages.build]);
 for(const text of ['menú','menu','carta','precios','Hola, ¿me compartes la carta porfa?','¿Cuáles son los precios?','¿Qué precio tiene el combo personal?']){
  const rows=await send(text);expect(rows.map(m=>m.media_url)).toEqual([responseImages.combos,responseImages.build]);
 }
 const replyPhone='+573000019999';
 await send('Hola');
 await r.conversations.handle({phone:replyPhone,text:'dirección',eventId:crypto.randomUUID()});
 const announcement=await r.messaging.sendNow(replyPhone,'Abrimos el jueves','opening_general_20261126');
 for(const text of ['menú','carta','precios']){
  await r.conversations.handle({phone:replyPhone,text,eventId:crypto.randomUUID(),replyToMessageId:announcement.messageId});
 }
 const replies=(await db.query<any>('SELECT m.kind,m.media_url FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 ORDER BY m.created_at',[replyPhone])).rows;
 expect(replies.slice(2).map(m=>m.media_url)).toEqual(Array.from({length:3},()=>[responseImages.combos,responseImages.build]).flat());
 const delivery=await send('¿Llegan a Envigado?');expect(delivery).toHaveLength(1);expect(delivery[0].media_url).toBe(responseImages.delivery);expect(delivery[0].body).toContain('$15.000');
 expect((await db.query('SELECT id FROM orders')).rowCount).toBe(0);
});
it('keeps the active cart and does not interrupt a human takeover',async()=>{
 const db=await createTestDb();dbs.push(db);const r=await buildRuntime(configSchema.parse({NODE_ENV:'test',BOT_MODE:'ordering',WHATSAPP_PROVIDER:'demo'}),db);const phone='+573000012345';
 await r.conversations.handle({phone,text:'dirección',eventId:crypto.randomUUID()});
 const ctx={orderingOptIn:true,cart:[{menuItemId:'existing',quantity:2}],deliveryAddress:'Calle 10 #43-20'};
 await db.query("INSERT INTO conversations(phone_e164,state,context_json,updated_at) VALUES($1,'ENTERING_ADDRESS',$2,now()) ON CONFLICT(phone_e164) DO UPDATE SET state='ENTERING_ADDRESS',context_json=$2",[phone,JSON.stringify(ctx)]);
 await r.conversations.handle({phone,text:'¿Dónde puedo recoger?',eventId:crypto.randomUUID()});
 expect((await db.query<any>('SELECT context_json FROM conversations WHERE phone_e164=$1',[phone])).rows[0].context_json).toEqual(ctx);
 await db.query("UPDATE conversations SET state='HUMAN_HANDOFF' WHERE phone_e164=$1",[phone]);const before=(await db.query('SELECT id FROM message_outbox')).rowCount;
 await r.conversations.handle({phone,text:'ubicación',eventId:crypto.randomUUID()});expect((await db.query('SELECT id FROM message_outbox')).rowCount).toBe(before);
});
