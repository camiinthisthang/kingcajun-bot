import {afterEach,describe,expect,it,vi} from 'vitest';
import {configSchema} from '../src/config.js';
import {createTestDb,type Db} from '../src/db/index.js';
import {buildRuntime} from '../src/runtime.js';
import {Dialog360WhatsAppProvider,MetaWhatsAppProvider} from '../src/providers/whatsapp.js';
import {canUseBot} from '../src/lib/bot-access.js';
import {createPhonePreviewDb} from '../src/phone-preview.js';
import {PaymentNotificationService} from '../src/services/payment-notifications.js';
const allowed='+15105550123',other='+573005551234';
const cfg=configSchema.parse({NODE_ENV:'test',BOT_MODE:'ordering',BOT_AUDIENCE:'allowlist',WHATSAPP_ALLOWED_NUMBERS:allowed,PAYMENT_PROVIDER:'cash_on_delivery'});
const databases:Db[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.close()));});
async function setup(){const db=await createTestDb();databases.push(db);return buildRuntime(cfg,db);}
const message=(phone:string,text:string,eventId=crypto.randomUUID())=>({phone,text,eventId});
describe('private WhatsApp allowlist',()=>{
 it('fails closed for an empty, malformed, local-only or accidentally ignored allowlist',()=>{
  for(const numbers of ['', ' ', '5105550123', '+15105550123,', '+15105550123,*'])expect(configSchema.safeParse({...cfg,WHATSAPP_ALLOWED_NUMBERS:numbers}).success).toBe(false);
  expect(configSchema.safeParse({...cfg,BOT_AUDIENCE:'all'}).success).toBe(false);
  expect(configSchema.safeParse({...cfg,PHONE_PREVIEW:true}).success).toBe(true);
  expect(configSchema.safeParse({...cfg,PHONE_PREVIEW:true,BOT_AUDIENCE:'all',WHATSAPP_ALLOWED_NUMBERS:''}).success).toBe(false);
  expect(configSchema.safeParse({...cfg,PHONE_PREVIEW:true,PAYMENT_PROVIDER:'demo'}).success).toBe(false);
  expect(canUseBot(cfg,allowed)).toBe(true);expect(canUseBot(cfg,'15105550123')).toBe(true);
  expect(canUseBot(cfg,'5105550123')).toBe(false);expect(canUseBot(cfg,other)).toBe(false);
 });
 it('silently consumes excluded events without customer, session or order creation, even when retried after access changes',async()=>{
  const r=await setup();
  for(const text of ['hola','Hacer pedido','MENÚ',''])expect(await r.conversations.handle(message(other,text))).toMatchObject({replied:false});
  for(const table of ['customers','conversations','orders','message_outbox'])expect((await r.db.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
  const event=message(other,'Hacer pedido');await r.conversations.handle(event);
  const opened=await buildRuntime({...cfg,WHATSAPP_ALLOWED_NUMBERS:other},r.db);
  expect(await opened.conversations.handle(event)).toEqual({duplicate:true});
  await expect(r.orders.create({phone:other,cart:[],fulfillmentType:'delivery',windowId:'missing'})).rejects.toThrow('allowlist');
 });
 it('lets the approved international number finish the full cash-on-delivery flow, while standby still overrides access',async()=>{
  const r=await setup();
  for(const text of ['hola','Hacer pedido','Selfie Bucket salsa de la casa suave','no','1, Calle 10 #43-20, El Poblado, Medellín'])await r.conversations.handle(message(allowed,text));
  expect((await r.db.query('SELECT status FROM orders')).rows).toEqual([{status:'confirmed'}]);
  expect((await r.db.query('SELECT state FROM conversations')).rows).toEqual([{state:'MAIN_MENU'}]);
  const stopped=await buildRuntime({...cfg,BOT_MODE:'standby'},r.db);
  expect(await stopped.conversations.handle(message(allowed,'MENÚ'))).toEqual({mode:'standby',replied:false});
  await expect(stopped.whatsapp.sendText(allowed,'test')).rejects.toThrow('standby');
 });
 it.each([Dialog360WhatsAppProvider,MetaWhatsAppProvider])('blocks every outbound transport path to excluded numbers before any network request',async(Provider)=>{
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({messages:[{id:'test'}]})));
  const provider=new Provider(cfg);
  const sends=[()=>provider.sendText(other,'test'),()=>provider.sendButtons(other,'test',[{id:'a',title:'Test'}]),()=>provider.sendImage(other,'https://example.com/menu.jpg','test'),()=>provider.sendReminder(other,'reminder_24h','test',[]),()=>provider.sendPaymentAlert(other,'test',[])];
  for(const send of sends)await expect(send()).rejects.toThrow('allowlist');
  expect(network).not.toHaveBeenCalled();
  await provider.sendText(allowed,'test');expect(network).toHaveBeenCalledTimes(1);
 });
 it('only sends due reminders to allowed numbers, leaving other reminders unclaimed',async()=>{
  const r=await setup();
  await r.db.query("UPDATE delivery_windows SET starts_at=starts_at+interval '7 days',ends_at=ends_at+interval '7 days',order_cutoff_at=order_cutoff_at+interval '7 days'");
  const unrestricted=await buildRuntime({...cfg,BOT_AUDIENCE:'all',WHATSAPP_ALLOWED_NUMBERS:''},r.db);
  for(const phone of [allowed,other])for(const text of ['Hacer pedido','Selfie Bucket salsa de la casa suave','no','1, Calle 10 #43-20, El Poblado, Medellín'])await unrestricted.conversations.handle(message(phone,text));
  await r.db.query("UPDATE message_outbox SET due_at=now()-interval '1 minute' WHERE kind LIKE 'reminder_%'");
  const send=vi.spyOn(r.whatsapp,'sendReminder');
  expect(await r.reminders.runDue()).toEqual({sent:2});expect(send.mock.calls.map(c=>c[0])).toEqual([allowed,allowed]);
  expect((await r.db.query("SELECT m.status,m.attempts FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 AND m.kind LIKE 'reminder_%'",[other])).rows).toEqual([{status:'pending',attempts:0},{status:'pending',attempts:0}]);
 });
 it('runs a complete rehearsal in disposable storage without changing the source database',async()=>{
  const source=await setup();const seed:any={};
  for(const table of ['menu_items','costing_state','bot_flow','bot_flow_history','delivery_windows','delivery_date_limits','referral_codes'])seed[table]=(await source.db.query(`SELECT * FROM ${table}`)).rows;
  seed.orders=[{public_id:'must-not-import'}];
  const previewDb=await createPhonePreviewDb(seed);databases.push(previewDb);
  const preview=await buildRuntime({...cfg,NODE_ENV:'production',PHONE_PREVIEW:true},previewDb);
  for(const text of ['Hacer pedido','Selfie Bucket salsa de la casa suave','no','1, Calle 10 #43-20, El Poblado, Medellín'])await preview.conversations.handle(message(allowed,text));
  expect((await previewDb.query('SELECT status FROM orders')).rows).toEqual([{status:'confirmed'}]);
  expect((await source.db.query('SELECT id FROM orders')).rowCount).toBe(0);
  expect((await source.db.query('SELECT phone_e164 FROM conversations')).rowCount).toBe(0);
 });
 it('suppresses payment notifications to excluded customers and staff',async()=>{
  const messaging={sendNow:vi.fn(),sendPaymentAlertNow:vi.fn()};
  const notifications=new PaymentNotificationService({...cfg,PAYMENT_ALERT_WHATSAPP_NUMBERS:other},messaging as any);
  expect(await notifications.handle({duplicate:false,confirmed:true,order:{phone_e164:other,starts_at:'2099-10-10T17:00:00Z',ends_at:'2099-10-10T19:00:00Z'}},{amountCop:20000} as any)).toEqual({customerSent:false,staffSent:0});
  expect(messaging.sendNow).not.toHaveBeenCalled();expect(messaging.sendPaymentAlertNow).not.toHaveBeenCalled();
 });
});
