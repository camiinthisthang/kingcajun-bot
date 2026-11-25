import express from 'express';
import {resolve} from 'node:path';
import {createFirstLookStore,migrateFirstLook,InviteError} from './first-look.mjs';

export function registerFirstLook(app,{db,root,requireAdmin,sameOrigin,preview=false,now,guestOrigin=''}){
  const store=createFirstLookStore(db,{preview,...(now?{now}:{})}),ready=migrateFirstLook(db),directory=resolve(root,'public/first-look');
  app.locals.firstLookReady=ready;app.locals.firstLookStore=store;
  void ready.catch(()=>console.error('First-look initialization failed'));
  const security=(_req,res,next)=>{res.set({'X-Robots-Tag':'noindex, nofollow, noarchive','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"});next();};
  const wrap=handler=>async(req,res)=>{try{await ready;return res.json(await handler(req));}catch(error){if(!(error instanceof InviteError))console.error('First-look request failed',error.code||error.name);return res.status(error instanceof InviteError?error.status:500).json({error:error instanceof InviteError?error.message:'No pudimos guardar. Reintenta sin cambiar los datos.',code:error instanceof InviteError?error.code:'server_error'});}};
  const guestWrite=(req,res,next)=>{if(!req.is('application/json'))return res.status(415).json({error:'Envía datos JSON.'});const origin=req.get('origin');if(guestOrigin&&origin===guestOrigin)return next();return sameOrigin(req,res,next);};
  const write=(req,res,next)=>req.is('application/json')?sameOrigin(req,res,next):res.status(415).json({error:'Envía datos JSON.'});
  const hits=new Map();
  const limit=(req,res,next)=>{const now=Date.now(),key=req.ip||'unknown';if(hits.size>1000)for(const [k,v]of hits)if(v.until<=now)hits.delete(k);let hit=hits.get(key);if(!hit||hit.until<=now)hit={count:0,until:now+60000};hit.count++;hits.set(key,hit);if(hit.count>100){res.set('Retry-After','60');return res.status(429).json({error:'Espera un momento y vuelve a intentarlo.'});}next();};
  app.use('/invitacion',security);
  app.use('/vik-assets',security,express.static(directory,{index:false,maxAge:0}));
  app.use('/api/first-look',security);
  app.get(['/invitacion','/amigos-y-familia','/vip','/influencers'],security,(_req,res)=>res.sendFile(resolve(directory,'index.html')));
  app.get(['/invitacion/:token','/invitacion/:audience/:token'],security,async(req,res)=>{try{await ready;const snapshot=await store.read(req.params.token);const audience=snapshot.invite.audience;if(req.params.audience!==audience)return res.redirect(302,'/invitacion/'+audience+'/'+encodeURIComponent(req.params.token));return res.sendFile(resolve(directory,'index.html'));}catch(error){return res.status(error instanceof InviteError?error.status:500).sendFile(resolve(directory,'index.html'));}});
  app.get('/api/first-look/public-config',security,(_req,res)=>res.json({guestOrigin:guestOrigin||null}));
  app.get('/reservas',requireAdmin,security,(_req,res)=>res.sendFile(resolve(directory,'admin.html')));
  app.get('/api/first-look/admin/state',requireAdmin,wrap(async()=>({...await store.adminState(),guestOrigin:guestOrigin||null})));
  app.post('/api/first-look/admin/invites',requireAdmin,write,wrap(req=>store.issue(req.body)));
  app.put('/api/first-look/admin/events/:id',requireAdmin,write,wrap(req=>store.configure(req.params.id,req.body)));
  app.get('/api/first-look/passes/:token',limit,wrap(req=>store.read(req.params.token)));
  app.post('/api/first-look/passes/:token',limit,guestWrite,wrap(req=>store.act(req.params.token,req.body)));
  return store;
}
