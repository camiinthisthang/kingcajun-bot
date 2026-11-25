import {readSlots,saveSlot} from './pos/slots.mjs';
import {migratePos,WorkflowError} from './pos/runtime.mjs';
import {migrateStaff,staffAuth,provisionStaff} from './pos/auth.mjs';
import {claimJobs,finishJob} from './pos/jobs.mjs';
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import express from 'express';
import {createTableStore,tableCatalog,tablePushDispatcher,TableError,migrateTableService} from './table-service.mjs';

export function registerTableRoutes(app,{db,root,requireAdmin,sameOrigin,sessionSecret,production,publicUrl,kitchenOnly=false,posEnabled=false,validAdmin,adminUser,printToken}){
  const store=createTableStore(db,tableCatalog,{onto:posEnabled});
  const ready=migrateTableService(db).then(async()=>{if(posEnabled){await migratePos(db);await migrateStaff(db);}});app.locals.tableReady=ready;
  void ready.catch(()=>console.error('Table service initialization failed'));
  const auth=posEnabled?staffAuth(db,{validAdmin,adminUser,production,kitchenOnly}):null;
  const access=posEnabled?async(req,res,next)=>{await ready;return auth.requireStaff(req,res,next);}:requireAdmin;
  const sign=id=>createHmac('sha256',sessionSecret).update('table-device:'+id).digest('base64url');
  const device=req=>{
    const raw=(req.headers.cookie||'').split(';').map(p=>p.trim()).find(p=>p.startsWith('kc_table_device='))?.slice(16);
    if(!raw)return null;const [id,sig]=raw.split('.');if(!/^[a-f0-9-]{36}$/.test(id)||!sig)return null;
    const expected=sign(id),a=Buffer.from(sig),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b)?id:null;
  };
  const route=fn=>async(req,res)=>{try{await ready;res.json(await fn(req,res));}catch(e){if(!(e instanceof TableError)&&!(e instanceof WorkflowError)&&![400,401,403,409].includes(e.status))console.error('Table service request failed',e.code||e.name);res.status(e instanceof TableError||e instanceof WorkflowError||[400,401,403,409].includes(e.status)?e.status:500).json({error:e instanceof TableError||e instanceof WorkflowError||[400,401,403,409].includes(e.status)?e.message:'No se pudo guardar. Reintenta sin cambiar el pedido.',code:e instanceof TableError||e instanceof WorkflowError?e.code:'server_error'});}};
  const write=(req,res,next)=>{if(!req.is('application/json'))return res.status(415).json({error:'Envía datos JSON.'});return sameOrigin(req,res,next);};
  const phoneOnly=(req,res,next)=>kitchenOnly?res.status(403).json({error:'Usa la aplicación de mesas para esta acción.'}):next();
  const requireDevice=req=>{const id=device(req);if(!id)throw new TableError('Vuelve a abrir Mesas para identificar este teléfono.',401);return id;};
  const publicDir=resolve(root,'public/table-service');
  app.use('/mesas/assets',express.static(publicDir,{index:false,maxAge:0}));
  if(posEnabled){
    app.get('/mesas/login',(_req,res)=>res.sendFile(resolve(publicDir,'login.html')));
    app.post('/api/dine-in/login',write,async(req,res,next)=>{try{await ready;await auth.login(req,res);}catch(e){next(e);}});
    app.post('/api/dine-in/logout',access,write,auth.logout);
    app.get('/api/dine-in/windows',access,route(()=>readSlots(db)));
    app.post('/api/dine-in/windows',access,write,route(req=>saveSlot(db,req.body,req.posActor)));
    app.get('/api/dine-in/me',access,route(req=>req.posActor));
    app.post('/api/dine-in/staff',access,write,route(req=>{if(!req.posActor.owner)throw new TableError('Solo la cuenta administradora puede crear usuarios.',403);return provisionStaff(db,req.body);}));
    app.get('/api/dine-in/staff',access,route(async req=>{if(!req.posActor.owner)throw new TableError('Acceso solo de administración.',403);return (await db.query('SELECT id,name,login,roles,active FROM pos_staff ORDER BY name')).rows;}));
    app.get('/api/dine-in/jobs',access,route(async()=> (await db.query("SELECT j.id,j.ticket_id,j.kind,CASE WHEN d.delivered_at IS NOT NULL THEN 'delivered' ELSE j.state END AS state,j.attempts,j.last_error,j.provider_id,j.created_at,j.completed_at FROM pos_jobs j LEFT JOIN whatsapp_delivery_receipts d ON d.provider_message_id=j.provider_id ORDER BY j.created_at DESC LIMIT 100")).rows));
    app.post('/api/dine-in/jobs/:id/retry',access,write,route(async req=>{
      if(!req.posActor.roles.includes('Manager'))throw new TableError('Requiere permiso de administración.',403);
      if(req.body.verifiedNotReceived!==true)throw new TableError('Confirma primero que el mensaje o ticket no llegó.');
      const r=await db.query("UPDATE pos_jobs SET state='pending',next_at=now(),last_error=NULL WHERE id=$1 AND state IN ('failed','blocked','unknown') RETURNING id",[req.params.id]);return {retried:r.rows.length===1};
    }));
    app.post('/api/dine-in/tickets/:id/reprint',access,write,route(async req=>{
      const t=await store.ticket(Number(req.params.id));if(!t)throw new TableError('Comanda no encontrada.',404);
      if(!/^[\w-]{16,100}$/.test(req.body.requestId||''))throw new TableError('Falta identificador.');
      await db.query("INSERT INTO pos_jobs(id,ticket_id,kind,event_key,payload) VALUES($1,$2,'print',$3,$4::jsonb) ON CONFLICT(event_key) DO NOTHING",[randomUUID(),t.id,`reprint:${t.id}:${req.body.requestId}`,JSON.stringify({ticket:t,event:t.state,copy:true})]);return {queued:true};
    }));
    const bridge=(req,res,next)=>{const token=req.headers.authorization?.replace(/^Bearer /,'')||'';if(!printToken||printToken.length<32||token.length!==printToken.length||!timingSafeEqual(Buffer.from(token),Buffer.from(printToken)))return res.status(401).json({error:'unauthorized'});next();};
    app.post('/api/pos/print/claim',bridge,route(()=>claimJobs(db,'print',1)));
    app.post('/api/pos/print/result',bridge,route(req=>finishJob(db,{id:req.body.id,lease:req.body.lease},{state:req.body.state,providerId:req.body.providerId,error:req.body.error}).then(()=>({ok:true}))));
  }
  app.get('/mesas/manifest.webmanifest',(_req,res)=>res.type('application/manifest+json').sendFile(resolve(publicDir,'manifest.webmanifest')));
  app.get('/mesas/service-worker.js',(_req,res)=>{res.setHeader('Service-Worker-Allowed','/mesas/');res.type('text/javascript').sendFile(resolve(publicDir,'service-worker.js'));});
  app.get(['/mesas','/mesas/','/mesas/app','/mesas/cocina'],access,(req,res)=>{if(kitchenOnly&&req.path!=='/mesas/cocina')return res.redirect('/kitchen?view=mesas');if(req.path==='/mesas'||req.path==='/mesas/')return res.redirect('/mesas/app');res.sendFile(resolve(publicDir,'index.html'));});
  app.get('/api/dine-in/device',access,phoneOnly,route((req,res)=>{
    let id=device(req);if(!id){id=randomUUID();res.append('Set-Cookie',`kc_table_device=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${production?'; Secure':''}`);}return {deviceId:id};
  }));
  app.get('/api/dine-in/catalog',access,route(()=>tableCatalog(db)));
  app.get('/api/dine-in/state',access,route(async req=>({...await store.state(),workflow:posEnabled?'onto':null,actor:req.posActor??null})));
  app.get('/api/dine-in/tickets/:id/history',access,route(req=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw new TableError('Comanda inválida.');return store.history(id);}));
  app.post('/api/dine-in/tickets',access,phoneOnly,write,route(req=>store.create({...req.body,deviceId:requireDevice(req)},req.posActor)));
  app.post('/api/dine-in/tickets/:id/state',access,write,route(req=>{
    const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw new TableError('Comanda inválida.');
    if(kitchenOnly&&!['cooking','ready','cancelled'].includes(req.body.state))throw new TableError('Acción solo de la mesera.',403);
    return store.transition(id,req.body,req.posActor);
  }));
  app.post('/api/dine-in/visits/:id/close',access,phoneOnly,write,route(req=>store.closeVisit(req.params.id,req.body,req.posActor)));
  const config=ready.then(()=>production&&publicUrl?store.pushConfig(new URL(publicUrl).origin):null);
  // Retain initialization errors for API replies without unhandled rejections.
  void config.catch(()=>console.error('Table push initialization failed'));
  app.get('/api/dine-in/push/config',access,phoneOnly,route(async()=>{const c=await config;return {enabled:Boolean(c),publicKey:c?.publicKey??null};}));
  app.post('/api/dine-in/push/subscribe',access,phoneOnly,write,route(async req=>{if(!await config)throw new TableError('Notificaciones no configuradas.',503);return store.subscribe(requireDevice(req),req.body.subscription);}));
  app.post('/api/dine-in/push/unsubscribe',access,phoneOnly,write,route(req=>{if(typeof req.body.endpoint!=='string')throw new TableError('Suscripción inválida.');return store.unsubscribe(requireDevice(req),req.body.endpoint);}));
  let timer,stopped=false;
  if(production)void config.then(c=>{if(!c||stopped)return;const flush=tablePushDispatcher(store,c);timer=setInterval(()=>void flush().catch(()=>console.error('Table notification retry pending')),2000);timer.unref();}).catch(()=>{});
  return ()=>{stopped=true;clearInterval(timer);};
}
