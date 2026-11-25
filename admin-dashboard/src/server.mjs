import {migrateBankMail} from './bank-mail.mjs';
import {registerBankMailRoutes} from './bank-mail-routes.mjs';
import {registerScheduledRoutes} from './scheduled-routes.mjs';
import {financeSnapshot,addFinanceEntry,voidFinanceEntry} from './finances.mjs';
import {registerTableRoutes} from './table-routes.mjs';
import {registerMarketing} from './marketing-content.mjs';
import {registerFirstLook} from './first-look-routes.mjs';
import {saveDispatchPlan} from './dispatch-plan.mjs';
import {saveRouteSettlement} from './route-settlements.mjs';
import {readDeliveryRoutes,saveRiderCount} from './delivery-routes.mjs';
import {readDeliveryWaitlist,updateDeliveryWaitlist} from './prepaid-capacity.mjs';
import {readOpeningWaitlist,prepareOpeningCampaign,openingCampaignDetail,queueOpeningCampaign,cancelOpeningCampaign} from './opening-waitlist.mjs';
import {resolveDeliveryCoverage} from './delivery-coverage.mjs';
import {resolveLocationInput,saveDispatchLocation} from './dispatch-location.mjs';
import {FlowError,flowFields,readFlow,saveFlow,publishFlow} from './flow/store.mjs';
import {readCosting,changeCosting,costingHistory} from './costing/store.mjs';
import {PricingError} from './costing/pricing.mjs';
import 'dotenv/config';
import {recordDeliveryPayment} from './delivery-payments.mjs';
import {confirmManualTransfer} from './manual-transfers.mjs';
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { addSpend, createReferralCode, dashboardSnapshot, normalizeFilters, openOrderDb, updateGoal, updateReferralCode } from './db.mjs';
import { getCatalog, saveCatalog, listRuns, createRun, getRun, changeRun } from './kitchen-store.mjs';
import { publishMenu, sourceStatus } from './kitchen-sync.mjs';
import { KitchenError,quoteOrder } from './kitchen-domain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
export function createDashboardApp({ db, adminUser = 'admin', adminPassword, sessionSecret, publicUrl, production = false, localOnly = false, kitchenOnly = false, kitchenNoLogin = false, localAdminNoLogin = false, paymentMode = process.env.PAYMENT_PROVIDER, posEnabled = process.env.POS_RUNTIME_ENABLED === 'true', printToken = process.env.POS_PRINT_TOKEN }) {
if (kitchenNoLogin && (!kitchenOnly || production)) throw new Error('Kitchen without login is only allowed on a local kitchen-only listener');
if (localAdminNoLogin && (production || kitchenOnly || !publicUrl || !['127.0.0.1','localhost'].includes(new URL(publicUrl).hostname))) throw new Error('Admin without login requires a non-production loopback listener');
if (!adminPassword || adminPassword.length < 10) throw new Error('ADMIN_DASHBOARD_PASSWORD must contain at least 10 characters');
if (!sessionSecret || sessionSecret.length < 32) throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters');
if (production && (!publicUrl || new URL(publicUrl).protocol !== 'https:')) throw new Error('ADMIN_PUBLIC_URL must be HTTPS in production');
const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
const app = express();
app.disable('x-powered-by');
if (production) app.set('trust proxy', 1);
app.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
app.use('/api/flow',express.json({limit:'512kb'}));
app.use(express.json({ limit: '64kb' }));

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};
const sign = (value) => createHmac('sha256', sessionSecret).update(value).digest('base64url');
const cookies = (header = '') => Object.fromEntries(header.split(';').map((part) => part.trim().split('=')).filter((pair) => pair.length === 2));
const sessionFor = (username) => {
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ username, expires })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
const validSession = (req) => {
  try {
    if (localAdminNoLogin) {
      const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const host = new URL(`http://${req.get('host')}`);
      const origin = req.header('origin');
      if (['127.0.0.1','::1'].includes(peer) && ['127.0.0.1','localhost'].includes(host.hostname) && host.port === new URL(publicUrl).port && (!origin || origin === host.origin)) return true;
    }
    const token = cookies(req.header('cookie')).kc_admin;
    if (!token) return false;
    const [payload, signature] = token.split('.');
    if (!safeEqual(signature, sign(payload))) return false;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return session.username === adminUser && session.expires > Date.now();
  } catch { return false; }
};
const requireAdmin = (req, res, next) => {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (kitchenNoLogin && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(peer)) return next();
  if (validSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect(req.path.startsWith('/mesas') ? '/login?next=mesas' : ['/kitchen','/costos','/flow','/waitlist','/routes','/marketing','/reservas'].includes(req.path) ? '/login?next='+req.path.slice(1) : '/login');
};
const sameOrigin = (req, res, next) => {
  const origin = req.header('origin');
  if (!origin || origin === (publicOrigin || `${req.protocol}://${req.get('host')}`)) return next();
  return res.status(403).json({ error: 'invalid_origin' });
};

const attempts = new Map();
// These routes share the existing authenticated dashboard and PostgreSQL database.
app.locals.stopTableNotifications=registerTableRoutes(app,{db,root,requireAdmin,sameOrigin,sessionSecret,production,publicUrl,kitchenOnly,posEnabled,validAdmin:validSession,adminUser,printToken});
// A separately authenticated kitchen listener uses an explicit route/action
// allowlist. Hiding navigation alone must never grant administrative access.
if (kitchenOnly) {
  const assets = new Set(['kitchen.css','kitchen.js','kitchen-search.js','kitchen-quantities.js','kitchen-presentation.js','route-trips.js','service-periods.js','table-kitchen.js']);
  const actions = new Set(['start','prep','portion','packingCheck','pack','reopen','complete','acknowledgeSource']);
  app.use((req,res,next) => {
    if (req.path === '/' && ['GET','HEAD'].includes(req.method)) return res.redirect('/kitchen');
    if (['GET','HEAD'].includes(req.method) && (
      ['/login','/health','/kitchen','/api/kitchen/source','/api/kitchen/catalog','/api/kitchen/runs'].includes(req.path) ||
      /^\/api\/kitchen\/runs\/[a-f0-9-]{36}$/i.test(req.path) ||
      req.path.startsWith('/admin-assets/') && assets.has(req.path.slice('/admin-assets/'.length))
    )) return next();
    if (req.path === '/api/session' && ['POST','DELETE'].includes(req.method)) return next();
    if (req.method === 'POST' && /^\/api\/kitchen\/runs\/[a-f0-9-]{36}\/actions$/i.test(req.path) && actions.has(req.body?.action?.type)) return next();
    return res.status(403).json({error:'Acceso solo a cocina. Administración, pagos, precios y cupos requieren a Camila.'});
  });
}
if(!kitchenOnly)registerMarketing(app,{db,root,requireAdmin,sameOrigin});
if(!kitchenOnly)registerFirstLook(app,{db,root,requireAdmin,sameOrigin,guestOrigin:production?'https://reservas.kingcajun.co':''});
app.get('/', (req,res)=>{const host=(req.hostname||'').toLowerCase();if(['kingcajun.co','www.kingcajun.co','reservas.kingcajun.co'].includes(host))return res.sendFile(resolve(root,'public/first-look/welcome.html'));return res.redirect(validSession(req)?'/admin':'/login');});
app.get('/login', (req, res) => {
  if (kitchenNoLogin) return res.redirect('/kitchen');
  if (validSession(req)) return res.redirect(['kitchen','costos','flow','waitlist','routes','mesas','marketing','reservas'].includes(req.query.next) ? '/'+req.query.next : '/admin');
  return res.sendFile(resolve(root, 'public/login.html'));
});
app.post('/api/session', sameOrigin, (req, res) => {
  const key = req.ip || 'unknown';
  const current = attempts.get(key) || { count: 0, blockedUntil: 0 };
  if (current.blockedUntil > Date.now()) return res.status(429).json({ error: 'try_later' });
  const valid = safeEqual(req.body?.username, adminUser) && safeEqual(req.body?.password, adminPassword);
  if (!valid) {
    current.count += 1;
    if (current.count >= 5) { current.count = 0; current.blockedUntil = Date.now() + 60_000; }
    attempts.set(key, current);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  attempts.delete(key);
  const secure = production ? '; Secure' : '';
  res.setHeader('Set-Cookie', `kc_admin=${sessionFor(adminUser)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
  return res.json({ ok: true });
});
app.delete('/api/session', requireAdmin, sameOrigin, (_req, res) => {
  res.setHeader('Set-Cookie', 'kc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return res.json({ ok: true });
});

app.get('/routes',requireAdmin,(_req,res)=>res.sendFile(resolve(root,'public/routes.html')));
app.get('/admin', requireAdmin, (_req, res) => res.sendFile(resolve(root, 'public/index.html')));
app.get('/waitlist',requireAdmin,(_req,res)=>res.sendFile(resolve(root,'public/opening-waitlist.html')));
app.get('/flow', requireAdmin, (_req,res)=>res.sendFile(resolve(root,'public/flow.html')));
app.get('/costos', requireAdmin, (_req, res) => res.sendFile(resolve(root, 'public/costing.html')));
app.get('/kitchen', requireAdmin, (_req, res) => {
  if (!kitchenOnly) return res.sendFile(resolve(root, 'public/kitchen.html'));
  const html = readFileSync(resolve(root,'public/kitchen.html'),'utf8')
    .replace('</head>', '<style>a[href="/admin"],a[href="/costos"],#new-run,[data-command="ingredient"],[data-command="product"],[data-command="publishMenu"],[data-command="order"],[data-command="cancel"],#rider-count-form,label:has(#dispatch-mode),[data-column-move]{display:none!important}</style></head>')
    .replace('Uso interno','Solo cocina');
  return res.type('html').send(html);
});
app.use('/admin-assets', requireAdmin, express.static(resolve(root, 'public'), { index: false, maxAge: '1h' }));

const kitchenRoute = handler => async (req, res) => {
  try { return res.json({ data: await handler(req) }); }
  catch (error) {
    if (error instanceof FlowError || error instanceof KitchenError || error instanceof PricingError) return res.status(error.status).json({ error: error.message });
    if (error.code === '22P02' || error.code === '22007') return res.status(400).json({ error: 'Identificador o valor inválido.' });
    console.error('Kitchen request failed', error.code || error.name);
    return res.status(500).json({ error: 'No se pudo guardar. Actualiza para comprobar el estado antes de intentarlo otra vez.' });
  }
};
app.get('/api/flow', requireAdmin, kitchenRoute(async()=>({...await readFlow(db),fields:flowFields,localOnly,paymentMode})));
app.put('/api/flow', requireAdmin, sameOrigin, kitchenRoute(req=>saveFlow(db,req.body,adminUser)));
app.post('/api/flow/publish', requireAdmin, sameOrigin, kitchenRoute(req=>publishFlow(db,req.body,adminUser)));
app.post('/api/admin/orders/:publicId/resolve-delivery', requireAdmin, sameOrigin, kitchenRoute(req => resolveDeliveryCoverage(db, String(req.params.publicId), req.body, adminUser)));
registerBankMailRoutes(app,{db,root,requireAdmin,sameOrigin,publicUrl});
registerScheduledRoutes(app,{db,root,requireAdmin,sameOrigin,adminUser});
app.get('/api/admin/routes/dates',requireAdmin,kitchenRoute(async()=> (await db.query("SELECT DISTINCT (starts_at AT TIME ZONE 'America/Bogota')::date::text AS date FROM delivery_windows ORDER BY date DESC LIMIT 100")).rows.map(r=>r.date)));
app.get('/api/admin/routes',requireAdmin,kitchenRoute(req=>readDeliveryRoutes(db,req.query.date || new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'}),req.query.period||'')));
app.post('/api/kitchen/routes/plan',requireAdmin,sameOrigin,kitchenRoute(req=>saveDispatchPlan(db,req.body.date,req.body)));
app.post('/api/kitchen/routes/riders',requireAdmin,sameOrigin,kitchenRoute(req=>saveRiderCount(db,req.body.date,req.body.count)));
app.post('/api/admin/routes/settlement',requireAdmin,sameOrigin,kitchenRoute(req=>saveRouteSettlement(db,req.body.date,req.body.driver,req.body,readDeliveryRoutes)));
app.post('/api/admin/dispatch-location/resolve', requireAdmin, sameOrigin, kitchenRoute(req => resolveLocationInput(req.body)));
app.put('/api/admin/orders/:publicId/dispatch-location', requireAdmin, sameOrigin, kitchenRoute(req => saveDispatchLocation(db, String(req.params.publicId), req.body, adminUser)));
app.post('/api/admin/orders/:publicId/confirm-transfer', requireAdmin, sameOrigin, kitchenRoute(req => confirmManualTransfer(db, String(req.params.publicId), req.body, adminUser)));
app.post('/api/admin/orders/:publicId/collect-payment', requireAdmin, sameOrigin, kitchenRoute(req => recordDeliveryPayment(db, String(req.params.publicId), req.body, adminUser)));
app.get('/api/costing', requireAdmin, kitchenRoute(async () => {const result=await readCosting(db);return result?{...result,localOnly}:null;}));
app.post('/api/costing/preview', requireAdmin, sameOrigin, kitchenRoute(req => changeCosting(db,req.body,adminUser,true)));
app.post('/api/costing/save', requireAdmin, sameOrigin, kitchenRoute(req => changeCosting(db,req.body,adminUser)));
app.get('/api/costing/history', requireAdmin, kitchenRoute(() => costingHistory(db)));
app.get('/api/costing/history/:version', requireAdmin, kitchenRoute(req => costingHistory(db,Number(req.params.version))));
app.get('/api/kitchen/source', requireAdmin, kitchenRoute(async () => ({...await sourceStatus(db),localOnly})));
app.post('/api/kitchen/publish-menu', requireAdmin, sameOrigin, kitchenRoute(req => publishMenu(db, req.body.version)));
app.post('/api/kitchen/quote', requireAdmin, sameOrigin, kitchenRoute(async req => {
 const c=await getCatalog(db);if(req.body.version!==c.version)throw new KitchenError('El menú cambió. Actualiza antes de cotizar.',409);
 return quoteOrder(c.document,{...req.body.order,reference:'Cotización',customer:'Cotización'},true);
}));
app.get('/api/kitchen/catalog', requireAdmin, kitchenRoute(() => getCatalog(db)));
app.put('/api/kitchen/catalog', requireAdmin, sameOrigin, kitchenRoute(req => saveCatalog(db, req.body)));
app.get('/api/kitchen/runs', requireAdmin, kitchenRoute(() => listRuns(db)));
app.post('/api/kitchen/runs', requireAdmin, sameOrigin, kitchenRoute(req => createRun(db, req.body)));
app.get('/api/kitchen/runs/:id', requireAdmin, kitchenRoute(req => getRun(db, req.params.id)));
app.post('/api/kitchen/runs/:id/actions', requireAdmin, sameOrigin, kitchenRoute(req => changeRun(db, req.params.id, req.body)));

app.get('/api/admin/waitlist', requireAdmin, kitchenRoute(()=>readDeliveryWaitlist(db)));
app.get('/api/admin/opening-waitlist',requireAdmin,kitchenRoute(()=>readOpeningWaitlist(db)));
app.post('/api/admin/opening-waitlist/preview',requireAdmin,sameOrigin,kitchenRoute(req=>prepareOpeningCampaign(db,req.body,adminUser)));
app.get('/api/admin/opening-waitlist/campaigns/:id',requireAdmin,kitchenRoute(req=>openingCampaignDetail(db,req.params.id)));
app.post('/api/admin/opening-waitlist/campaigns/:id/send',requireAdmin,sameOrigin,kitchenRoute(req=>queueOpeningCampaign(db,req.params.id,req.body)));
app.post('/api/admin/opening-waitlist/campaigns/:id/cancel',requireAdmin,sameOrigin,kitchenRoute(req=>cancelOpeningCampaign(db,req.params.id)));
app.patch('/api/admin/waitlist/:id', requireAdmin, sameOrigin, kitchenRoute(req=>updateDeliveryWaitlist(db,req.params.id,req.body.status,adminUser)));

app.get('/api/admin/finances',requireAdmin,kitchenRoute(req=>financeSnapshot(db,req.query)));
app.post('/api/admin/finances/entries',requireAdmin,sameOrigin,kitchenRoute(req=>addFinanceEntry(db,req.body,adminUser)));
app.patch('/api/admin/finances/entries/:id',requireAdmin,sameOrigin,kitchenRoute(req=>voidFinanceEntry(db,req.params.id,req.body.voided,adminUser)));

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try { return res.json({ data: await dashboardSnapshot(db, normalizeFilters(req.query)) }); }
  catch (error) { console.error(error); return res.status(500).json({ error: 'dashboard_query_failed' }); }
});
app.post('/api/admin/spend', requireAdmin, sameOrigin, async (req, res) => {
  const amountCop = Number(req.body?.amountCop);
  const campaignName = String(req.body?.campaignName || '').trim();
  const spentAt = String(req.body?.spentAt || '');
  if (!Number.isInteger(amountCop) || amountCop < 0 || !campaignName || !/^\d{4}-\d{2}-\d{2}$/.test(spentAt)) {
    return res.status(400).json({ error: 'invalid_spend' });
  }
  try {
    const result = await addSpend(db, {
      influencerId: String(req.body?.influencerId || ''),
      referralCodeId: String(req.body?.referralCodeId || ''),
      campaignName,
      amountCop,
      spentAt: `${spentAt}T17:00:00.000Z`,
      notes: String(req.body?.notes || '').trim()
    });
    return res.status(201).json({ data: result });
  } catch (error) { console.error(error); return res.status(400).json({ error: 'spend_not_saved' }); }
});
const referralInput = (body, requireExistingCreator = false) => {
  const code = String(body?.code || '').trim().toUpperCase();
  const influencerId = String(body?.influencerId || '').trim();
  const creatorName = String(body?.creatorName || '').trim();
  const creatorHandle = String(body?.creatorHandle || '').trim();
  const creatorPlatform = String(body?.creatorPlatform || '').trim();
  const campaignName = String(body?.campaignName || '').trim();
  const contentUrl = String(body?.contentUrl || '').trim();
  const validFrom = String(body?.validFrom || '').trim();
  const validUntil = String(body?.validUntil || '').trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw new Error('invalid_code');
  if ((!influencerId && (requireExistingCreator || creatorName.length < 2 || creatorName.length > 80)) || creatorHandle.length > 80 || creatorPlatform.length > 40 || campaignName.length > 120) throw new Error('invalid_creator');
  if ((validFrom && !datePattern.test(validFrom)) || (validUntil && !datePattern.test(validUntil)) || (validFrom && validUntil && validFrom > validUntil)) throw new Error('invalid_dates');
  if (contentUrl) {
    try { if (!['http:', 'https:'].includes(new URL(contentUrl).protocol)) throw new Error(); }
    catch { throw new Error('invalid_url'); }
  }
  return {
    code, influencerId, creatorName, creatorHandle, creatorPlatform, campaignName, contentUrl,
    validFrom: validFrom ? `${validFrom}T05:00:00.000Z` : '',
    validUntil: validUntil ? new Date(new Date(`${validUntil}T05:00:00.000Z`).getTime() + 86400000 - 1).toISOString() : '',
    freeDelivery: body?.freeDelivery === true, active: body?.active !== false
  };
};
const referralError = (res, error) => {
  const code = error instanceof Error ? error.message : 'referral_not_saved';
  const statuses = { code_exists: 409, creator_name_exists: 409, code_not_found: 404, creator_not_found: 404 };
  return res.status(statuses[code] || 400).json({ error: code });
};
app.post('/api/admin/referral-codes', requireAdmin, sameOrigin, async (req, res) => {
  try { return res.status(201).json({ data: await createReferralCode(db, referralInput(req.body)) }); }
  catch (error) { return referralError(res, error); }
});
app.put('/api/admin/referral-codes/:codeId', requireAdmin, sameOrigin, async (req, res) => {
  try { return res.json({ data: await updateReferralCode(db, String(req.params.codeId), referralInput(req.body, true)) }); }
  catch (error) { return referralError(res, error); }
});
app.put('/api/admin/goals/:stageKey', requireAdmin, sameOrigin, async (req, res) => {
  const orderTarget = Number(req.body?.orderTarget);
  const revenueTargetCop = Number(req.body?.revenueTargetCop);
  const targetDate = String(req.body?.targetDate || '');
  if (!Number.isInteger(orderTarget) || orderTarget <= 0 || !Number.isInteger(revenueTargetCop) || revenueTargetCop <= 0 || (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))) {
    return res.status(400).json({ error: 'invalid_goal' });
  }
  return await updateGoal(db, String(req.params.stageKey), { orderTarget, revenueTargetCop, targetDate })
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'goal_not_found' });
});
app.get('/health', async (_req, res) => {
  try { await app.locals.tableReady; await db.query('SELECT 1'); return res.json({ ok: true, source: 'whatsapp-order-db' }); }
  catch { return res.status(503).json({ ok: false }); }
});
app.use((error, _req, res, _next) => { console.error('Dashboard request failed', error.code || error.name); res.status(500).json({error:'request_failed'}); });
return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await openOrderDb(process.env.DATABASE_URL);
  await migrateBankMail(db);
  const app = createDashboardApp({db, adminUser:process.env.ADMIN_DASHBOARD_USER || 'admin',
    adminPassword:process.env.ADMIN_DASHBOARD_PASSWORD, sessionSecret:process.env.ADMIN_SESSION_SECRET,
    publicUrl:process.env.ADMIN_PUBLIC_URL, production:process.env.NODE_ENV === 'production'});
  const port = Number(process.env.PORT || process.env.ADMIN_DASHBOARD_PORT || 3002);
  const server = app.listen(port, '0.0.0.0', () => console.log(`King Cajun Admin listening on port ${port}`));
  const shutdown = () => {app.locals.stopTableNotifications();server.close(async () => { await db.close(); process.exit(0); });};
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
