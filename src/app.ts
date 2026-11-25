import {responseImages} from './services/restaurant-information.js';
import {applyStaffConfirmation,isStaffOrderConfirmation,isStaffResumeCommand} from '../admin-dashboard/src/staff-confirmations.mjs';
import {staffDraftCreator} from './services/staff-orders.js';
import {staffResumeHandler} from './services/staff-resume.js';
import {StaffPaymentReader} from './services/staff-payment-reader.js';
import {canUseBot} from './lib/bot-access.js';
import {recordReminderDelivery} from '../admin-dashboard/src/reminder-confirmations.mjs';
import {recordOpeningDeliveryStatus} from '../admin-dashboard/src/opening-waitlist.mjs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Runtime } from './runtime.js';
import { normalizePhone, cop } from './lib/format.js';
import { isWhatsAppConfigured, parseBusinessEchoes, parseMetaMessages, verifyMetaSignature } from './providers/whatsapp.js';
import type { PaymentConfirmation } from './types.js';
import { resolve } from 'node:path';
import { mainMenuButtons } from './services/main-menu.js';
import { publicBotOpen } from './lib/bot-access.js';

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createApp(cfg: Config, runtime: Runtime, liveTest?: Runtime) {
  const isLiveTest=(phone:string)=>Boolean(liveTest&&phone===cfg.LIVE_TEST_PHONE&&cfg.LIVE_TEST_UNTIL&&Date.now()<Date.parse(cfg.LIVE_TEST_UNTIL));
  const app = express();
  const staffPayments=new StaffPaymentReader(cfg);
  // A silent service can be deployed before onboarding, but must reject webhooks
  // until its real credentials are configured. This never implies API connectivity.
  const whatsappConfigured = isWhatsAppConfigured(cfg);
  app.use(express.json({
    limit: '256kb',
    verify: (req: any, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
  }));

  const admin = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.ADMIN_API_KEY && cfg.NODE_ENV !== 'production') return next();
    if (safeEqual(String(req.header('x-admin-api-key') ?? ''), cfg.ADMIN_API_KEY)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
  const internal = (req: Request, res: Response, next: NextFunction) => {
    if (safeEqual(String(req.header('x-internal-api-key') ?? ''), cfg.INTERNAL_API_KEY)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };

  app.get('/health', async (_req, res) => {
    try {
      await runtime.db.query('SELECT 1 AS ok');
      return res.json({
        ok: true,
        database: 'connected',
        storage: cfg.PHONE_PREVIEW ? 'disposable_phone_preview' : 'configured_database',
        conversation: { interpreter: cfg.AI_ORDERING_ENABLED ? 'ai' : 'rules', model: cfg.AI_ORDERING_ENABLED ? cfg.OPENAI_MODEL : null },
        whatsapp_configured: whatsappConfigured,
        uptime_seconds: Math.floor(process.uptime()),
        mode: { bot: cfg.BOT_MODE, audience: cfg.BOT_AUDIENCE, newOrdersPaused:cfg.NEW_ORDERS_PAUSED, newOrdersPauseReason:cfg.NEW_ORDERS_PAUSE_REASON??'temporary', newOrdersFullPayment:cfg.NEW_ORDERS_FULL_PAYMENT, newOrdersCheckBackAt:cfg.NEW_ORDERS_PAUSE_REASON==='capacity'?null:cfg.NEW_ORDERS_CHECK_BACK_AT??null, publicOpensAt: cfg.BOT_PUBLIC_OPENS_AT ?? null, publicOpen:publicBotOpen(cfg), whatsapp: cfg.WHATSAPP_PROVIDER, payment: cfg.PAYMENT_PROVIDER }
      });
    } catch (error) {
      console.error('Health check failed', error);
      return res.status(503).json({ ok: false, database: 'unavailable' });
    }
  });
  for(const path of [...Object.values(responseImages),'/assets/payments-20261124/bre-b.png','/assets/campaigns/opening-20261126/announcement.png','/assets/campaigns/opening-20261126/coupon.png'])app.get(path,(_req,res)=>{
    res.setHeader('Cache-Control','public, max-age=31536000, immutable');
    return res.sendFile(resolve('.'+path));
  });
  // Retire legacy artwork URLs. Only approved response and campaign graphics are served.
  app.use('/assets',(_req,res)=>res.status(410).json({error:'artwork_retired'}));
  app.use(['/api/v1/menu','/api/v1/delivery-windows'],async (_req,_res,next)=>{try{await runtime.refreshCatalog();next();}catch(error){next(error);}});
  app.get('/api/v1/menu', async (_req, res) => {
    await runtime.orders.loadMenu();res.setHeader('Cache-Control','no-store');
    return res.json({menu_version:runtime.orders.menuVersion(),data:runtime.orders.menu().map(item=>{
      const meta=JSON.parse(item.metadata_json);
      return {id:item.id,slug:item.slug,sku:item.sku,name:item.name,description:item.description,category:item.category,price_cop:item.price_cop,unit:meta.kitchen?.product?.unit,baseQuantity:meta.kitchen?.product?.baseQuantity,components:(meta.costing?.components??[]).map((c:any)=>({name:c.name,quantity:c.quantity,unit:c.unit,pieces:c.pieces}))};
    })});
  });
  app.get('/api/v1/delivery-windows', async (_req, res) => res.json({ data: await runtime.orders.availableWindows('delivery') }));
  app.get('/api/v1/orders/:publicId', admin, async (req, res) => {
    const order = await runtime.orders.orderByPublicId(String(req.params.publicId));
    return order ? res.json({ data: order }) : res.status(404).json({ error: 'not_found' });
  });
  app.get('/api/v1/orders', admin, async (_req, res) => res.json({ data: (await runtime.db.query(`
    SELECT o.public_id, o.status, o.fulfillment_type, o.total_cop, o.payment_reference, o.created_at,
           c.phone_e164, c.display_name, w.starts_at, w.ends_at, r.code AS referral_code
    FROM orders o JOIN customers c ON c.id = o.customer_id JOIN delivery_windows w ON w.id = o.delivery_window_id
    LEFT JOIN referral_codes r ON r.id = o.referral_code_id ORDER BY o.created_at DESC
  `)).rows }));
  app.get('/api/v1/customers', admin, async (_req, res) => res.json({ data: (await runtime.db.query(`SELECT id, phone_e164, display_name, locale, created_at, updated_at FROM customers ORDER BY created_at DESC`)).rows }));
  app.get('/api/v1/referral-codes', admin, async (_req, res) => res.json({ data: (await runtime.db.query(`SELECT id, code, influencer_name, active, valid_from, valid_until, created_at FROM referral_codes ORDER BY code`)).rows }));
  app.get('/api/v1/payments', admin, async (_req, res) => res.json({ data: (await runtime.db.query(`
    SELECT p.provider, p.provider_payment_id, p.reference, p.amount_cop, p.status, p.confirmed_at, o.public_id
    FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.created_at DESC
  `)).rows }));

  app.get('/webhooks/whatsapp', (req, res) => {
    if (!whatsappConfigured) return res.status(503).json({ error: 'whatsapp_not_configured' });
    if (cfg.WHATSAPP_PROVIDER === '360dialog') {
      return res.sendStatus(safeEqual(req.header('x-webhook-secret') ?? '', cfg.D360_WEBHOOK_SECRET) ? 200 : 401);
    }
    if (req.query['hub.mode'] === 'subscribe' && safeEqual(String(req.query['hub.verify_token'] ?? ''), cfg.WHATSAPP_VERIFY_TOKEN)) {
      return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    }
    return res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', async (req: any, res) => {
    if (!whatsappConfigured) return res.status(503).json({ error: 'whatsapp_not_configured' });
    if (cfg.WHATSAPP_PROVIDER === 'meta' && !verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), cfg.META_APP_SECRET)) {
      return res.sendStatus(401);
    }
    if (cfg.WHATSAPP_PROVIDER === '360dialog' && !safeEqual(req.header('x-webhook-secret') ?? '', cfg.D360_WEBHOOK_SECRET)) {
      return res.sendStatus(401);
    }
    const messages = parseMetaMessages(req.body, cfg.WHATSAPP_PROVIDER === '360dialog' ? cfg.WHATSAPP_PHONE_NUMBER_ID : undefined);
    // Safe diagnostics distinguish incoming messages from delivery-status events;
    // do not log customer text, phone numbers, handles or scoped identifiers.
    console.info('WhatsApp webhook received', { parsedMessages: messages.length, usernameOnlyMessages: messages.filter(message=>message.phone.startsWith('bsuid:')).length });
    if(Array.isArray(req.body?.entry))for(const entry of req.body.entry){
      if(!Array.isArray(entry?.changes))continue;
      for(const change of entry.changes){
        if(change?.field!=='messages'||!Array.isArray(change?.value?.statuses))continue;
        for(const status of change.value.statuses)console.info('WhatsApp delivery status',{
          status:status?.status,
          errorCodes:Array.isArray(status?.errors)?status.errors.map((error:any)=>error?.code):[]
        });
      }
    }
    try {
      for(const entry of Array.isArray(req.body?.entry)?req.body.entry:[])for(const change of Array.isArray(entry?.changes)?entry.changes:[]){
        if(change?.field!=='messages'||!Array.isArray(change?.value?.statuses))continue;
        if(cfg.WHATSAPP_PHONE_NUMBER_ID&&change.value?.metadata?.phone_number_id!==cfg.WHATSAPP_PHONE_NUMBER_ID)continue;
        for(const status of change.value.statuses){
          await recordOpeningDeliveryStatus(runtime.db,status);
          if(['delivered','read'].includes(status?.status)&&typeof status.id==='string'&&/^\d+$/.test(String(status.timestamp))){
            const at=new Date(Number(status.timestamp)*1000);
            if(Number.isFinite(+at)&&+at<=Date.now()+60000)await recordReminderDelivery(runtime.db,status.id,at);
          }
        }
      }
      await runtime.refreshCatalog();
      if(cfg.BOT_MODE==='ordering')for(const echo of parseBusinessEchoes(req.body,cfg.WHATSAPP_PHONE_NUMBER_ID??'')){
        if(isLiveTest(echo.phone))continue;
        if(canUseBot(cfg,echo.phone)){
          const apply=()=>applyStaffConfirmation(runtime.db,echo,new Date(),{createDraft:staffDraftCreator(cfg),resumeChat:staffResumeHandler(cfg),readPaymentEvidence:(tx:any,event:any,order:any,now:any)=>staffPayments.read(tx,event,order,now),paymentInstructions:cfg.MANUAL_TRANSFER_INSTRUCTIONS});
          // A manual reply/STOP must preempt a slow AI request instead of waiting
          // behind it. Confirmation/resume still serialize with order mutations.
          const result=isStaffOrderConfirmation(echo.text)||isStaffResumeCommand(echo.text)
            ? await runtime.conversations.serialize(echo.phone,apply) : await apply();
          if(result.outcome==='applied')await runtime.reminders.runDue();
        }
      }
      // Do not acknowledge prelaunch messages before they are durably processed.
      for (const message of messages) await (isLiveTest(message.phone)?liveTest!:runtime).conversations.handle(message);
      return res.sendStatus(200);
    } catch (error) {
      console.error('WhatsApp webhook processing failed', error);
      return res.sendStatus(503);
    }
  });

  app.post('/webhooks/payments/bancolombia', async (req, res) => {
    if (cfg.BOT_MODE === 'standby') return res.status(503).json({ error: 'bot_in_standby' });
    if (cfg.PAYMENT_PROVIDER !== 'bancolombia') return res.status(404).json({ error: 'provider_disabled' });
    if (!cfg.BANCOLOMBIA_CALLBACK_API_KEY || !safeEqual(String(req.header('x-api-key') ?? ''), cfg.BANCOLOMBIA_CALLBACK_API_KEY)) {
      return res.status(401).json({ error: 'invalid_callback_key' });
    }
    try {
      const event = mapBancolombiaCallback(req.body);
      const result = await runtime.paymentEvents.confirm(event);
      res.status(200).json({ received: true, duplicate: result.duplicate });
      void runtime.paymentNotifications.handle(result, event).catch(console.error);
      return;
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/internal/reminders/run', internal, async (_req, res) => res.json(await runtime.reminders.runDue()));

  if (cfg.NODE_ENV !== 'production' && cfg.WHATSAPP_PROVIDER === 'demo') {
    app.get('/demo', (_req, res) =>
      res.set('Cache-Control', 'no-store').type('html').send(demoPage(cfg.BUSINESS_NAME)),
    );
    app.post('/demo/messages', async (req, res) => {
      try {
        const phone = normalizePhone(String(req.body.phone ?? '3001234567'));
        const result = await runtime.conversations.handle({ eventId: `demo-${randomUUID()}`, phone, displayName: 'Cliente Demo', text: String(req.body.text ?? 'hola'),
          ...(typeof req.body.actionId === 'string' ? { actionId: req.body.actionId } : {}) });
        return res.json({ data: result });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    });
    app.get('/demo/messages', async (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        const phone = normalizePhone(String(req.query.phone ?? '3001234567'));
        const rows = (await runtime.db.query(`
          SELECT id, kind, body, media_url, buttons_json, direction, created_at FROM (
            SELECT w.id, 'customer_message' AS kind, w.payload_json->>'text' AS body,
                   NULL AS media_url, NULL::jsonb AS buttons_json, 'inbound' AS direction, w.received_at AS created_at, 0 AS sequence
            FROM webhook_events w
            WHERE w.provider = 'whatsapp' AND w.payload_json->>'phone' = $1
            UNION ALL
            SELECT m.id, m.kind, m.body, m.media_url, m.buttons_json, 'outbound' AS direction,
                   m.created_at, 1 AS sequence
            FROM message_outbox m
            JOIN customers c ON c.id = m.customer_id
            WHERE c.phone_e164 = $1 AND m.status = 'sent'
          ) ORDER BY created_at, sequence
        `, [phone])).rows;
        if(cfg.POS_RUNTIME_ENABLED){const progress=(await runtime.db.query("SELECT id,'order_progress' AS kind,payload->>'body' AS body,NULL AS media_url,NULL::jsonb AS buttons_json,'outbound' AS direction,created_at FROM pos_jobs WHERE kind='whatsapp' AND payload->>'phone'=$1 AND state IN ('sent','simulated')",[phone])).rows;rows.push(...progress);rows.sort((a:any,b:any)=>+new Date(a.created_at)-+new Date(b.created_at));}
        return res.json({ data: rows.map(row => ({ ...row, ...(row.kind === 'main_menu' ? { buttons: row.buttons_json ?? mainMenuButtons } : {}) })) });
      } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    });
    app.post('/demo/reset', async (req, res) => {
      const phone = normalizePhone(String(req.body.phone ?? '3001234567'));
      const customer = (await runtime.db.query<{ id: string }>(`SELECT id::text FROM customers WHERE phone_e164 = $1`, [phone])).rows[0];
      if (customer) await runtime.db.query(`DELETE FROM message_outbox WHERE customer_id = $1`, [customer.id]);
      await runtime.db.query(`DELETE FROM webhook_events WHERE provider = 'whatsapp' AND payload_json->>'phone' = $1`, [phone]);
      await runtime.db.query(`DELETE FROM conversations WHERE phone_e164 = $1`, [phone]);
      return res.json({ reset: true });
    });
  }

  if (cfg.NODE_ENV !== 'production' && cfg.PAYMENT_PROVIDER === 'demo') {
    app.get('/demo/payment-bot', async (_req, res) =>
      res.set('Cache-Control', 'no-store').type('html').send(await paymentBotPage(runtime, cfg.BUSINESS_NAME)),
    );
    app.post('/demo/payment-bot/confirm/:reference', async (req, res) => {
      const reference = String(req.params.reference);
      const payment = (await runtime.db.query<{ amount_cop: number }>(`SELECT amount_cop FROM payments WHERE reference = $1`, [reference])).rows[0];
      if (!payment) return res.status(404).send('Pago no encontrado');
      const event: PaymentConfirmation = {
        eventId: `demo-payment-${randomUUID()}`, providerPaymentId: `demo-tx-${randomUUID()}`,
        reference, amountCop: payment.amount_cop, status: 'confirmed', raw: { source: 'demo' }
      };
      const result = await runtime.paymentEvents.confirm(event);
      await runtime.paymentNotifications.handle(result, event);
      return res.redirect(303, '/demo/payment-bot');
    });
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

function mapBancolombiaCallback(body: any): PaymentConfirmation {
  const status = String(body.status ?? body.data?.status ?? '').toUpperCase();
  const confirmed = ['APPROVED', 'SUCCESS', 'CONFIRMED', 'COMPLETED'].includes(status);
  const failed = ['FAILED', 'REJECTED', 'DECLINED', 'CANCELLED'].includes(status);
  if (!confirmed && !failed) throw new Error('Estado de pago no reconocido');
  const reference = String(body.reference ?? body.purchaseReference ?? body.data?.reference ?? '');
  const amountCop = Number(body.amount ?? body.data?.amount);
  const currency = String(body.currency ?? body.data?.currency ?? 'COP').toUpperCase();
  const providerPaymentId = String(body.transactionId ?? body.id ?? body.data?.id ?? '');
  const eventId = String(body.eventId ?? `${providerPaymentId}:${status}`);
  if (!reference || !providerPaymentId || !Number.isInteger(amountCop) || amountCop < 0 || currency !== 'COP') throw new Error('Callback incompleto o moneda inválida');
  return { eventId, providerPaymentId, reference, amountCop, status: confirmed ? 'confirmed' : 'failed', raw: body };
}

async function paymentBotPage(runtime: Runtime, name: string) {
  const payments = (await runtime.db.query<any>(`
    SELECT o.public_id, o.status AS order_status, o.total_cop, p.reference, p.status AS payment_status,
           c.phone_e164
    FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
    ORDER BY p.created_at DESC LIMIT 20
  `)).rows;
  const notifications = (await runtime.db.query<any>(`
    SELECT body, status, created_at FROM operational_notifications ORDER BY created_at DESC LIMIT 20
  `)).rows;
  const paymentCards = payments.length
    ? payments.map((payment) => `<article class="card"><b>${html(payment.public_id)}</b><div>${cop(payment.total_cop)} · ${html(payment.phone_e164)}</div><small>Referencia: ${html(payment.reference)}</small>${payment.payment_status === 'pending' ? `<form method="post" action="/demo/payment-bot/confirm/${encodeURIComponent(payment.reference)}"><button>Simular abono reportado por el banco</button></form>` : '<span class="paid">✓ Pago confirmado</span>'}</article>`).join('')
    : '<p class="empty">Todavía no hay pagos. Completa primero un pedido en el chat del cliente.</p>';
  const botMessages = notifications.length
    ? notifications.map((notification) => `<article class="bubble">${html(notification.body)}<small>${notification.status === 'sent' ? 'Enviado por WhatsApp' : 'No enviado'}</small></article>`).join('')
    : '<p class="empty">Cuando el banco reporte un pago, el bot lo mostrará aquí.</p>';
  return `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width"><title>${html(name)} · Bot de pagos</title>
  <style>body{margin:0;font:16px system-ui;background:#efeae2;color:#172b20}.wrap{max-width:760px;margin:auto;min-height:100vh;background:#f7f3ed}.head{position:sticky;top:0;background:#075e54;color:white;padding:18px 22px;display:flex;justify-content:space-between;align-items:center}.head a{color:white}.content{padding:22px}.card,.bubble{white-space:pre-wrap;background:white;padding:16px;margin:10px 0;border-radius:14px;box-shadow:0 1px 2px #0002}.card div,.card small{display:block;margin-top:5px}.card form{margin-top:14px}.card button{border:0;border-radius:20px;background:#25d366;padding:11px 16px;font-weight:bold}.paid{display:inline-block;color:#087a43;margin-top:12px}.bubble small{display:block;color:#68766f;margin-top:12px}.empty{color:#68766f}</style></head>
  <body><main class="wrap"><header class="head"><div><b>💰 Bot de pagos</b><div>Equipo ${html(name)}</div></div><a href="/demo">Volver al cliente</a></header><section class="content"><h2>Transferencias</h2>${paymentCards}<h2>Reportes enviados al equipo</h2>${botMessages}</section></main></body></html>`;
}

function html(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function demoPage(name: string) {
  return `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width"><title>${name} · Demo WhatsApp</title>
  <style>body{margin:0;font:16px system-ui;background:#efeae2;color:#172b20}.wrap{max-width:720px;margin:auto;min-height:100vh;background:#f7f3ed}.head{position:sticky;top:0;background:#075e54;color:white;padding:18px 22px;display:flex;justify-content:space-between;align-items:center;z-index:2}.head b{font-size:20px}.phone{font-size:12px;opacity:.8}.actions{display:flex;gap:10px;align-items:center}.actions a{color:white;text-decoration:none}.reset{border:1px solid #ffffff66;background:transparent;color:white;border-radius:16px;padding:7px 10px}.chat{padding:20px;min-height:70vh;display:flex;flex-direction:column}.bubble{white-space:pre-wrap;padding:12px 15px;margin:5px 0;max-width:78%;border-radius:4px 14px 14px 14px;box-shadow:0 1px 2px #0002}.outbound{align-self:flex-start;background:white}.inbound{align-self:flex-end;background:#d9fdd3;border-radius:14px 4px 14px 14px}.bubble img{display:block;max-width:100%;max-height:560px;border-radius:8px;margin-bottom:10px}.bubble a{overflow-wrap:anywhere}.send{position:sticky;bottom:0;display:flex;gap:8px;padding:14px;background:#ddd}.send input{flex:1;border:0;border-radius:24px;padding:14px;font-size:16px}.send button{border:0;border-radius:24px;background:#25d366;padding:0 22px;font-weight:bold}</style></head>
  <body><main class="wrap"><header class="head"><div><b>${name}</b><div class="phone">Cliente demo · +57 300 123 4567</div></div><div class="actions"><a href="/demo/payment-bot" target="_blank">💰 Bot de pagos</a><button id="reset" class="reset">Reiniciar demo</button></div></header><section id="chat" class="chat"></section>
  <form id="form" class="send"><input id="text" autocomplete="off" placeholder="Escribe un mensaje"><button>Enviar</button></form></main>
  <script>const phone=(new URLSearchParams(location.search).get('phone')||'3001234567').replace(/[^0-9+]/g,''),chat=document.querySelector('#chat'),input=document.querySelector('#text');let lastSignature='';
  const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const format=s=>esc(s).replace(/\\*([^*\\n]+)\\*/g,'<strong>$1</strong>').replace(/_([^_\\n]+)_/g,'<em>$1</em>').replace(/(https?:\\/\\/[^\\s<]+)/g,'<a target="_blank" href="$1">$1</a>');
  async function load(forceScroll=false){const j=await fetch('/demo/messages?phone='+phone,{cache:'no-store'}).then(r=>r.json());const messages=j.data||[];const signature=messages.map(m=>m.id).join('|');if(signature===lastSignature)return;const nearBottom=window.innerHeight+window.scrollY>=document.body.scrollHeight-140;chat.innerHTML=messages.map(m=>'<div class="bubble '+(m.direction==='inbound'?'inbound':'outbound')+'">'+(m.media_url?'<img src="'+esc(m.media_url)+'" alt="Menú">':'')+format(m.body)+'</div>').join('');lastSignature=signature;if(forceScroll||nearBottom||messages.length<=2)requestAnimationFrame(()=>window.scrollTo({top:document.body.scrollHeight,behavior:'auto'}))}
  async function send(text){await fetch('/demo/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,text})});await load(true)}
  document.querySelector('#form').onsubmit=async e=>{e.preventDefault();const t=input.value;if(!t)return;input.value='';await send(t)};document.querySelector('#reset').onclick=async()=>{lastSignature='';await fetch('/demo/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone})});await send('hola')};load().then(async()=>{if(!chat.children.length)await send('hola')});window.addEventListener('focus',()=>load(false));document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(false)});</script></body></html>`;
}
