import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {gmailScope,seal,googleToken,gmailGet} from './bank-mail.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function registerBankMailRoutes(app,{db,root,requireAdmin,sameOrigin,publicUrl,env=process.env}){
 const mailbox=String(env.BANK_MAIL_EMAIL||'').trim().toLowerCase();
 const redirect=publicUrl?new URL('/api/admin/bank-mail/callback',publicUrl).href:null;
 app.get('/bank-payments',requireAdmin,(_req,res)=>res.sendFile(root+'/public/bank-payments.html'));
 app.get('/api/admin/bank-mail',requireAdmin,async(_req,res)=>{try{
  const c=(await db.query('SELECT email,connected_at,checked_at,last_error FROM bank_mail_connection WHERE id=1')).rows[0];
  const events=(await db.query('SELECT b.gmail_id,b.amount_cop,b.payer,b.received_at,b.status,b.reason,o.public_id FROM bank_mail_events b LEFT JOIN orders o ON o.id=b.order_id ORDER BY b.created_at DESC LIMIT 50')).rows;
  const checks=(await db.query('SELECT o.public_id,b.status,b.attempts,b.last_error,b.requested_at FROM bank_mail_checks b JOIN orders o ON o.id=b.order_id ORDER BY b.requested_at DESC LIMIT 50')).rows;
  res.json({checks,configured:!!(env.GOOGLE_BANK_CLIENT_ID&&env.GOOGLE_BANK_CLIENT_SECRET&&env.BANK_MAIL_TOKEN_KEY),enabled:env.BANK_MAIL_ENABLED==='true',connection:c??null,events});
 }catch{res.status(503).json({error:'La conexión de pagos aún no está configurada.'});}});
 app.post('/api/admin/bank-mail/connect',requireAdmin,sameOrigin,async(_req,res)=>{try{
  if(!mailbox||!redirect||!env.GOOGLE_BANK_CLIENT_ID||!env.GOOGLE_BANK_CLIENT_SECRET||!env.BANK_MAIL_TOKEN_KEY)return res.status(503).json({error:'Falta configurar el cliente de Google.'});
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
  await db.query("INSERT INTO bank_mail_oauth(state_hash,verifier,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[hash(state),verifier]);
  res.setHeader('Set-Cookie',`kc_bank_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/bank-mail; Max-Age=900`);
  const params=new URLSearchParams({client_id:env.GOOGLE_BANK_CLIENT_ID,redirect_uri:redirect,response_type:'code',scope:gmailScope,access_type:'offline',prompt:'consent',state,login_hint:mailbox,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  res.json({url:'https://accounts.google.com/o/oauth2/v2/auth?'+params});
 }catch{res.status(500).json({error:'No se pudo iniciar la conexión.'});}});
 app.get('/api/admin/bank-mail/callback',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try{
   const state=typeof req.query.state==='string'?req.query.state:'',cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('kc_bank_oauth='))?.slice(14);
   if(!state||!equal(state,cookie))return res.status(400).send('La sesión de conexión venció. Inicia de nuevo desde Pagos.');
   const saved=(await db.query('DELETE FROM bank_mail_oauth WHERE state_hash=$1 AND expires_at>now() RETURNING verifier',[hash(state)])).rows[0];
   if(!saved||typeof req.query.code!=='string')return res.status(400).send('Google no autorizó la conexión. Puedes intentarlo de nuevo.');
   const tokens=await googleToken(env,{code:req.query.code,grant_type:'authorization_code',redirect_uri:redirect,code_verifier:saved.verifier});
   if(!tokens.refresh_token||!tokens.scope?.split(' ').includes(gmailScope))throw Error('missing_scope');
   const profile=await gmailGet(tokens.access_token,'profile');if(profile.emailAddress.toLowerCase()!==mailbox)throw Error('wrong_mailbox');
   await db.query("INSERT INTO bank_mail_connection(id,email,tokens,connected_at) VALUES(1,$1,$2,now()) ON CONFLICT(id) DO UPDATE SET email=excluded.email,tokens=excluded.tokens,checked_at=NULL,last_error=NULL",[profile.emailAddress,seal({refresh_token:tokens.refresh_token},env.BANK_MAIL_TOKEN_KEY)]);
   res.setHeader('Set-Cookie','kc_bank_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/bank-mail; Max-Age=0');return res.redirect('/bank-payments');
  }catch{return res.status(400).send('No se pudo conectar Gmail. Vuelve a Pagos y autoriza la cuenta configurada.');}
 });
}
