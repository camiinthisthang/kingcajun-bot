import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { config, configSchema, type Config } from '../src/config.js';
import { createTestDb, type Db } from '../src/db/index.js';
import { buildRuntime } from '../src/runtime.js';
import { createApp } from '../src/app.js';
import { parseMetaMessages } from '../src/providers/whatsapp.js';

const cfg: Config = { ...config, NODE_ENV: 'test', BOT_MODE: 'prelaunch',
  WHATSAPP_PROVIDER: 'demo', PAYMENT_PROVIDER: 'demo', DATABASE_URL: 'pglite://:memory:',
  PRELAUNCH_REPLY: '¡Hola! Pronto abriremos pedidos.', PRELAUNCH_REPLY_COOLDOWN_HOURS: 6 };
const databases: Db[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(databases.splice(0).map(db => db.close())); });
async function runtime(overrides: Partial<Config> = {}) {
  const db = await createTestDb(); databases.push(db);
  return buildRuntime({ ...cfg, ...overrides }, db);
}
const message = (eventId: string, text = 'hola') => ({eventId, phone: '+573000001234', text});
async function count(db: Db, table: string) {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
}

describe('prelaunch', () => {
  it('replies once to concurrent messages and duplicate delivery; creates no orders or payments', async () => {
    const r = await runtime();
    await Promise.all(['a', 'b', 'a'].map(id => r.conversations.handle(message(id, 'quiero pedir'))));
    const outbox = (await r.db.query(`SELECT kind, body, media_url FROM message_outbox`)).rows;
    expect(outbox).toEqual([{kind:'prelaunch_reply', body:cfg.PRELAUNCH_REPLY, media_url:null}]);
    expect(await count(r.db, 'webhook_events')).toBe(2);
    expect(await count(r.db, 'orders')).toBe(0);
    expect(await count(r.db, 'payments')).toBe(0);
    expect(await count(r.db, 'conversations')).toBe(0);
    expect(await r.orders.availableWindows()).toEqual([]);
    await expect(r.orders.create({ phone: message('x').phone, cart: [], fulfillmentType:'delivery', windowId:'unused' })).rejects.toThrow('todavía no');
    expect(await r.reminders.runDue()).toEqual({sent:0});
    await r.db.query(`UPDATE message_outbox SET sent_at = now() - interval '7 hours'`);
    await r.conversations.handle(message('c'));
    expect(await count(r.db, 'message_outbox')).toBe(2);
  });

  it('leaves a failed send retryable with the same webhook ID', async () => {
    const r = await runtime();
    vi.spyOn(r.whatsapp, 'sendText').mockRejectedValueOnce(new Error('temporary outage'));
    await expect(r.conversations.handle(message('retry'))).rejects.toThrow('temporary outage');
    expect(await count(r.db, 'webhook_events')).toBe(0);
    await expect(r.conversations.handle(message('retry'))).resolves.toEqual({mode:'prelaunch', replied:true});
    expect(await count(r.db, 'message_outbox')).toBe(1);
  });

  it('lets prelaunch visitors start ordering after an explicit switch', async () => {
    const db = await createTestDb(); databases.push(db);
    const closed = await buildRuntime(cfg, db);
    await closed.conversations.handle(message('closed'));
    const open = await buildRuntime({...cfg, BOT_MODE:'ordering'}, db);
    await expect(open.conversations.handle(message('open', 'Hacer pedido'))).resolves.toEqual({state:'CHOOSING_ITEM'});
    expect((await db.query(`SELECT kind FROM message_outbox WHERE kind = 'menu_image'`)).rowCount).toBe(1);
  });

  it('never populates a production database with example menu items or delivery windows', async () => {
    const r = await runtime({NODE_ENV:'production'});
    for (const table of ['menu_items', 'delivery_windows', 'referral_codes']) expect(await count(r.db, table)).toBe(0);
  });

  it('replies to media and ignores delivery receipts and system events', () => {
    const payload = {entry:[{changes:[{value:{messages:[{id:'voice',from:'573000001234',type:'audio',audio:{id:'media'}},{id:'system',from:'573000001234',type:'system'}],statuses:[{id:'receipt',status:'read'}]}}]}]};
    expect(parseMetaMessages(payload)).toEqual([{eventId:'voice',phone:'+573000001234',displayName:undefined,text:''}]);
  });

  it('hides the unpublished menu and returns 503 for a failed signed webhook before accepting a retry', async () => {
    const r = await runtime();
    const appCfg = {...cfg, WHATSAPP_PROVIDER:'meta' as const, META_APP_SECRET:'test-secret'};
    const server = createApp(appCfg,r).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.on('listening',resolve));
    const address=server.address() as {port:number};
    const base=`http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(base+'/api/v1/menu')).status).toBe(404);
      expect((await fetch(base+'/assets/menu.jpg')).status).toBe(404);
      const payload=JSON.stringify({entry:[{changes:[{value:{messages:[{id:'http-retry',from:'573000001234',type:'text',text:{body:'hola'}}]}}]}]});
      const headers={'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex')};
      expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',body:payload,headers:{'content-type':'application/json'}})).status).toBe(401);
      const failureLog=vi.spyOn(console,'error').mockImplementation(()=>{});
      vi.spyOn(r.whatsapp,'sendText').mockRejectedValueOnce(new Error('temporary outage'));
      expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',body:payload,headers})).status).toBe(503);
      expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',body:payload,headers})).status).toBe(200);
      expect(await count(r.db,'message_outbox')).toBe(1);
      failureLog.mockRestore();
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });
});

describe('launch configuration', () => {
  const production = {NODE_ENV:'production',DATABASE_URL:'postgresql://user:password@db.invalid/orders',PUBLIC_BASE_URL:'https://bot.example.com',WHATSAPP_PROVIDER:'meta',WHATSAPP_TOKEN:'token',WHATSAPP_PHONE_NUMBER_ID:'phone',META_APP_SECRET:'secret',WHATSAPP_VERIFY_TOKEN:'verify',ADMIN_API_KEY:'admin'};
  it('defaults to silent standby without requiring bank integration', () => {
    const result=configSchema.parse(production);
    expect(result.BOT_MODE).toBe('standby');
    expect(result.ALLOW_DEMO_PAYMENTS_IN_PRODUCTION).toBe(false);
  });
  it('allows deployment before Meta onboarding only in silent standby', () => {
    const unconfigured={...production,WHATSAPP_TOKEN:'',WHATSAPP_PHONE_NUMBER_ID:'',META_APP_SECRET:''};
    expect(configSchema.safeParse({...unconfigured,BOT_MODE:'standby'}).success).toBe(true);
    for (const BOT_MODE of ['prelaunch','ordering']) {
      const result=configSchema.safeParse({...unconfigured,BOT_MODE});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some(issue=>issue.path.includes('WHATSAPP_TOKEN'))).toBe(true);
    }
  });
  it('keeps production payment checks when orders are opened, including the string false', () => {
    expect(configSchema.safeParse({...production,BOT_MODE:'ordering',ALLOW_DEMO_PAYMENTS_IN_PRODUCTION:'false',PAYMENT_ALERT_WHATSAPP_NUMBERS:'+573000001234'}).success).toBe(false);
  });
  it('rejects blank replies and non-HTTPS production webhook URLs', () => {
    expect(configSchema.safeParse({...production,PRELAUNCH_REPLY:' '}).success).toBe(false);
    expect(configSchema.safeParse({...production,PUBLIC_BASE_URL:'http://bot.example.com'}).success).toBe(false);
  });
});

describe('silent standby', () => {
  it('reports unconfigured WhatsApp and rejects all webhooks before onboarding', async () => {
    const appCfg={...cfg,NODE_ENV:'production' as const,BOT_MODE:'standby' as const,WHATSAPP_PROVIDER:'meta' as const,WHATSAPP_TOKEN:'',WHATSAPP_PHONE_NUMBER_ID:'',META_APP_SECRET:''};
    const r=await runtime(appCfg);
    const server=createApp(appCfg,r).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.on('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      expect((await (await fetch(base+'/health')).json()).whatsapp_configured).toBe(false);
      expect((await fetch(base+'/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=123')).status).toBe(503);
      expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entry:[{changes:[{value:{messages:[{id:'unconfigured',from:'573000001234',type:'text',text:{body:'hola'}}]}}]}]})})).status).toBe(503);
      expect(await count(r.db,'webhook_events')).toBe(0);
      expect(await count(r.db,'orders')).toBe(0);
      expect(await count(r.db,'message_outbox')).toBe(0);
      await expect(r.whatsapp.sendText('+573000001234','test')).rejects.toThrow('standby');
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });
  it('consumes incoming events without replying or creating a customer, conversation, order or payment', async () => {
    const r = await runtime({BOT_MODE:'standby'});
    await expect(r.conversations.handle(message('standby-1'))).resolves.toEqual({mode:'standby',replied:false});
    await r.conversations.handle(message('standby-1'));
    expect(await count(r.db,'webhook_events')).toBe(1);
    for (const table of ['customers','conversations','orders','payments','message_outbox','operational_notifications']) {
      expect(await count(r.db,table)).toBe(0);
    }
    expect(await r.orders.availableWindows()).toEqual([]);
    await expect(r.orders.create({phone:message('x').phone,cart:[],fulfillmentType:'delivery',windowId:'unused'})).rejects.toThrow('todavía no');
    expect(await r.reminders.runDue()).toEqual({sent:0});
    const active = await buildRuntime({...cfg,BOT_MODE:'ordering'},r.db);
    await expect(active.conversations.handle(message('standby-1'))).resolves.toEqual({duplicate:true});
    expect(await count(r.db,'message_outbox')).toBe(0);
    await expect(active.conversations.handle(message('new-after-opening', 'Hacer pedido'))).resolves.toEqual({state:'CHOOSING_ITEM'});
  });

  it('blocks every provider send path without calling Meta, including reminders and staff notifications', async () => {
    const r = await runtime({BOT_MODE:'standby',WHATSAPP_PROVIDER:'meta'});
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const phone=message('x').phone;
    await expect(r.whatsapp.sendText(phone,'test')).rejects.toThrow('standby');
    await expect(r.whatsapp.sendImage(phone,'https://example.com/menu.jpg','test')).rejects.toThrow('standby');
    await expect(r.whatsapp.sendReminder(phone,'reminder_24h','test',[])).rejects.toThrow('standby');
    await expect(r.whatsapp.sendPaymentAlert(phone,'test',[])).rejects.toThrow('standby');
    expect(await r.paymentNotifications.handle({duplicate:false,confirmed:true,order:{}}, {eventId:'x',providerPaymentId:'x',reference:'x',amountCop:1,status:'confirmed',raw:{}})).toEqual({customerSent:false,staffSent:0});
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps webhook verification and signed receipt active with zero replies; hides menu and blocks bank callbacks', async () => {
    const r = await runtime({BOT_MODE:'standby'});
    const appCfg={...cfg,BOT_MODE:'standby' as const,WHATSAPP_PROVIDER:'meta' as const,META_APP_SECRET:'test-secret',WHATSAPP_VERIFY_TOKEN:'verify-test'};
    const server=createApp(appCfg,r).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.on('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      const challenge=await fetch(base+'/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=12345');
      expect(challenge.status).toBe(200);expect(await challenge.text()).toBe('12345');
      const body=JSON.stringify({entry:[{changes:[{value:{messages:[{id:'standby-http',from:'573000001234',type:'text',text:{body:'hola'}}]}}]}]});
      const headers={'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(body).digest('hex')};
      expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',body,headers:{'content-type':'application/json'}})).status).toBe(401);
      expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',body,headers})).status).toBe(200);
      expect((await fetch(base+'/api/v1/menu')).status).toBe(404);
      expect((await fetch(base+'/assets/menu.jpg')).status).toBe(404);
      expect((await (await fetch(base+'/api/v1/delivery-windows')).json()).data).toEqual([]);
      expect((await (await fetch(base+'/health')).json()).mode.bot).toBe('standby');
      expect((await fetch(base+'/webhooks/payments/bancolombia',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(503);
      expect(await count(r.db,'message_outbox')).toBe(0);
      expect(await count(r.db,'orders')).toBe(0);
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});
