import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {DateTime} from 'luxon';
import {recordStaffPayment} from './staff-payments.mjs';
export const gmailScope='https://www.googleapis.com/auth/gmail.readonly';
export const normalizePayer=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z ]/g,' ').replace(/\s+/g,' ').trim();
const digest=s=>createHash('sha256').update(s).digest('hex');
export async function migrateBankMail(db){await db.exec(`
 CREATE TABLE IF NOT EXISTS bank_mail_connection(id INTEGER PRIMARY KEY CHECK(id=1),email TEXT NOT NULL,tokens TEXT NOT NULL,connected_at TIMESTAMPTZ NOT NULL,checked_at TIMESTAMPTZ,last_error TEXT);
 CREATE TABLE IF NOT EXISTS bank_mail_oauth(state_hash TEXT PRIMARY KEY,verifier TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS bank_mail_events(gmail_id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE,amount_cop INTEGER,payer TEXT,received_at TIMESTAMPTZ,status TEXT NOT NULL,reason TEXT,order_id UUID REFERENCES orders(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS bank_mail_checks(order_id UUID PRIMARY KEY REFERENCES orders(id),receipt_id TEXT NOT NULL,requested_at TIMESTAMPTZ NOT NULL,next_check_at TIMESTAMPTZ NOT NULL,deadline TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',last_error TEXT);
 `);}
export function seal(value,key){const k=Buffer.from(key||'','base64');if(k.length!==32)throw Error('Configura BANK_MAIL_TOKEN_KEY.');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',k,iv);return Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64');}
export function unseal(value,key){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString());}
function decodeCodePoint(key){const hex=key[1].toLowerCase()==='x',n=parseInt(key.slice(hex?2:1),hex?16:10);return n>=0&&n<=0x10ffff?String.fromCodePoint(n):' ';}
function emailText(payload){
 if(payload?.body?.data&&['text/plain','text/html'].includes(payload.mimeType)){
  const text=Buffer.from(payload.body.data,'base64url').toString();if(payload.mimeType==='text/plain')return text;
  const entities={nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",aacute:'á',eacute:'é',iacute:'í',oacute:'ó',uacute:'ú',ntilde:'ñ',Aacute:'Á',Eacute:'É',Iacute:'Í',Oacute:'Ó',Uacute:'Ú',Ntilde:'Ñ'};
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(_,key)=>key[0]==='#'?decodeCodePoint(key):entities[key]??' ');
 }
 const parts=payload?.parts??[];const plain=parts.filter(p=>p.mimeType==='text/plain');return (plain.length?plain:parts).map(emailText).filter(Boolean).join('\n');
}
export function parseBankMail(message){
 const headers=message.payload?.headers??[];const get=n=>headers.filter(h=>h.name.toLowerCase()===n.toLowerCase()).map(h=>h.value);
 const from=get('From')[0]?.trim().toLowerCase();const domains=['ayn.notificacionesbancolombia.com','an.notificacionesbancolombia.com'];
 const address=from?.match(/(?:<|^)(alertasynotificaciones@(?:ayn|an)\.notificacionesbancolombia\.com)>?$/)?.[1];
 if(!address)return {reason:'Remitente no autorizado'};
 const auth=get('Authentication-Results').find(v=>/^mx\.google\.com\s*;/.test(v));const domain=address.split('@')[1];
 if(!auth||!domains.includes(domain)||!auth.includes('dkim=pass')||!auth.includes('dmarc=pass')||!auth.includes('header.from='+domain)||!auth.includes('header.i=@'+domain))return {reason:'Autenticación del banco no verificada'};
 const body=emailText(message.payload).replace(/\s+/g,' ').trim();
 const m=body.match(/KING CAJUN,?\s*recibiste un pago de (.+?) por \$([\d.,]+) en tu cuenta \*+(\d{4}) conectado a la llave (\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
 if(!m||m[3]!=='0000'||m[4]!=='0000000000')return {reason:'No es un pago al QR de King Cajun'};
 // Accept observed integer COP formats, optionally comma-grouped with .00 cents.
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.00)?$/.test(m[2]))return {reason:'Formato de valor desconocido'};
 const amount=Number(m[2].replace(/,/g,'')),payer=normalizePayer(m[1]),at=DateTime.fromFormat(m[5]+' '+m[6],'dd/MM/yyyy HH:mm',{zone:'America/Bogota'});
 if(!Number.isSafeInteger(amount)||amount<=0||!at.isValid||payer.split(' ').length<2)return {reason:'Datos de pago incompletos'};
 const receivedAt=at.toUTC().toISO();if(!message.internalDate||Math.abs(Number(message.internalDate)-at.toMillis())>24*3600000)return {reason:'Fecha del correo no coincide'};
 const fingerprint=digest([m[3],m[4],payer,amount,receivedAt].join('|'));
 return {amount,payer,receivedAt,fingerprint};
}
export async function reconcileBankMail(db,message,now=new Date(),targetOrderId=null){
 const parsed=parseBankMail(message);
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM scheduled_order_control WHERE id=1 FOR UPDATE');
  if((await tx.query('SELECT 1 FROM bank_mail_events WHERE gmail_id=$1',[message.id])).rowCount)return {status:'duplicate'};
  if(parsed.fingerprint&&(await tx.query('SELECT 1 FROM bank_mail_events WHERE fingerprint=$1',[parsed.fingerprint])).rowCount)return {status:'duplicate'};
  const insert=async(status,reason,orderId=null)=>{await tx.query('INSERT INTO bank_mail_events(gmail_id,fingerprint,amount_cop,payer,received_at,status,reason,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[message.id,parsed.fingerprint??null,parsed.amount??null,parsed.payer??null,parsed.receivedAt??null,status,reason,orderId]);return {status,reason};};
  if(parsed.reason)return insert('ignored',parsed.reason);
  const key='bank:gmail:'+message.id;
  if((await tx.query("SELECT 1 FROM payments WHERE status='confirmed' AND raw_payload_json->'evidenceKeys' ? $1",[key])).rowCount)return insert('already_recorded','Pago registrado previamente por el equipo');
  const candidates=(await tx.query(`SELECT o.*,w.starts_at,w.ends_at,c.phone_e164 FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id JOIN customers c ON c.id=o.customer_id WHERE o.status='awaiting_payment' AND o.full_payment_required=TRUE AND o.total_cop=$1 AND o.created_at<=$2::timestamptz+interval '1 minute' AND o.created_at>=$2::timestamptz-interval '24 hours'`,[parsed.amount,parsed.receivedAt])).rows.filter(o=>normalizePayer(o.delivery_coverage?.paymentPayerName)===parsed.payer);
  if(candidates.length!==1)return insert('review',candidates.length?'Más de un pedido coincide':'No hay un pedido con el mismo titular y valor');
  const o=candidates[0];if(targetOrderId&&o.id!==targetOrderId)return {status:'unrelated'};
  if(!(await tx.query('SELECT 1 FROM bank_mail_checks WHERE order_id=$1',[o.id])).rowCount)return {status:'not_requested'};
  if(new Date(o.payment_expires_at)<=now||new Date(o.starts_at)<=now||o.delivery_coverage?.needsReview)return insert('review','Reserva vencida o entrega pendiente de revisión',o.id);
  const paid=Number((await tx.query("SELECT COALESCE(sum(amount_cop),0)::int paid FROM payments WHERE order_id=$1 AND status='confirmed'",[o.id])).rows[0].paid);
  if(paid)return insert('review','El pedido ya tiene un pago parcial; requiere conciliación',o.id);
  await tx.query('SAVEPOINT bank_apply');
  try{
   const payment=await recordStaffPayment(tx,o.id,{eventId:'gmail:'+message.id,sentAt:now.toISOString()},{totalPaidCop:parsed.amount,previousPaidCop:0,basis:'authenticated_bank_email',keys:[key,'bank:fingerprint:'+parsed.fingerprint],evidenceIds:[message.id],summary:'Correo autenticado de Bancolombia: llave, cuenta, titular, valor y hora coinciden con un único pedido.'},now);
   if(payment.alreadyRecorded){await tx.query('RELEASE SAVEPOINT bank_apply');return insert('already_recorded','El equipo ya registró el pago',o.id);}
   await tx.query("UPDATE payments SET raw_payload_json=raw_payload_json||$2::jsonb WHERE order_id=$1 AND status='confirmed'",[o.id,JSON.stringify({source:'authenticated_bank_email',reviewedBy:'Gmail payment reconciliation',bankReceivedAt:parsed.receivedAt})]);
   const local=DateTime.fromJSDate(new Date(o.starts_at)).setZone('America/Bogota').setLocale('es-CO');const pickup=o.delivery_coverage?.method==='pickup';
   const body=`✅ Recibimos tu pago de $${parsed.amount.toLocaleString('es-CO')}. Tu pedido ${o.public_id} está confirmado.\n\n${pickup?'Recogida':'Domicilio'}: ${local.toFormat("cccc d 'de' LLLL, h:mm a")}${pickup?'':'–'+DateTime.fromJSDate(new Date(o.ends_at)).setZone('America/Bogota').toFormat('h:mm a')}\n📍 ${o.delivery_address}\nSaldo pendiente: $0.`;
   await tx.query("INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) VALUES(gen_random_uuid(),$1,$2,'staff_order_confirmation',$3,$4,'pending',$4)",[o.customer_id,o.id,body,now.toISOString()]);
   await tx.query('RELEASE SAVEPOINT bank_apply');return insert('confirmed','Pago y pedido confirmados',o.id);
  }catch(e){await tx.query('ROLLBACK TO SAVEPOINT bank_apply');return insert('review','La reserva o la capacidad cambió; revisa el pago antes de confirmar',o.id);}
 });
}
export async function googleToken(env,params){const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_BANK_CLIENT_ID,client_secret:env.GOOGLE_BANK_CLIENT_SECRET,...params}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Google requiere reconectar Gmail ('+r.status+').');return r.json();}
export async function gmailGet(token,path){const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('No se pudo leer Gmail ('+r.status+').');return r.json();}
// A receipt creates one durable, bounded check. Repeated screenshots never reset it.
export async function requestBankMailCheck(db,{phone,publicId,receiptId},now=new Date()){
 const rows=(await db.query(`SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone_e164=$1 AND o.status='awaiting_payment' AND o.full_payment_required=TRUE AND ($2::text IS NULL OR o.public_id=$2)`,[phone,publicId??null])).rows;
 if(!rows.length&&publicId){const paid=(await db.query(`SELECT 1 FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.public_id=$1 AND c.phone_e164=$2 AND o.status='confirmed' AND (SELECT COALESCE(sum(amount_cop),0) FROM payments WHERE order_id=o.id AND status='confirmed')>=o.total_cop`,[publicId,phone])).rowCount;if(paid)return {status:'matched'};}
 if(rows.length!==1)return {status:rows.length?'review':'not_applicable'};
 const o=rows[0],expires=+new Date(o.payment_expires_at);
 if(!receiptId||!o.delivery_coverage?.paymentPayerName||!Number.isFinite(expires)||expires<=+now)return {status:'review'};
 await db.query(`INSERT INTO bank_mail_checks(order_id,receipt_id,requested_at,next_check_at,deadline) VALUES($1,$2,$3,$3,$4) ON CONFLICT(order_id) DO NOTHING`,[o.id,receiptId,now.toISOString(),new Date(Math.min(expires,+now+10*60000)).toISOString()]);
 return (await db.query('SELECT status FROM bank_mail_checks WHERE order_id=$1',[o.id])).rows[0];
}
export async function pollBankMail(db,env=process.env,now=new Date()){
 if(env.BANK_MAIL_ENABLED!=='true')return;
 await db.query("UPDATE bank_mail_checks SET status='review',last_error='No llegó una coincidencia bancaria dentro del plazo; revisión manual.' WHERE status='pending' AND (deadline<=$1 OR attempts>=5 AND next_check_at<=$1)",[now.toISOString()]);
 // No Gmail API calls at all unless a receipt-triggered check is due.
 if(!(await db.query("SELECT 1 FROM bank_mail_checks WHERE status='pending' AND next_check_at<=$1 LIMIT 1",[now.toISOString()])).rowCount)return;
 const c=(await db.query('SELECT * FROM bank_mail_connection WHERE id=1')).rows[0];if(!c)return;
 const jobs=await db.transaction(async tx=>{
  const due=(await tx.query("SELECT * FROM bank_mail_checks WHERE status='pending' AND next_check_at<=$1 AND deadline>$1 AND attempts<5 ORDER BY next_check_at LIMIT 10 FOR UPDATE SKIP LOCKED",[now.toISOString()])).rows;
  for(const job of due)await tx.query("UPDATE bank_mail_checks SET attempts=attempts+1,next_check_at=$2 WHERE order_id=$1",[job.order_id,new Date(+now+120000).toISOString()]);return due;
 });if(!jobs.length)return;
 let auth,error;
 try{const saved=unseal(c.tokens,env.BANK_MAIL_TOKEN_KEY);auth=await googleToken(env,{grant_type:'refresh_token',refresh_token:saved.refresh_token});}catch(e){error=e.message;}
 for(const job of jobs){
  let status='pending',reason=null;
  try{
   if(error)throw Error(error);
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[job.order_id])).rows[0];
   if(o.status!=='awaiting_payment'){status=o.status==='confirmed'?'matched':'closed';}
   else{
    const q=`from:(alertasynotificaciones@ayn.notificacionesbancolombia.com) after:${Math.floor(+new Date(o.created_at)/1000)-60} before:${Math.ceil(+new Date(job.deadline)/1000)+1} -in:spam -in:trash`;
    const matches=new Map();let page,pages=0;
    do{const batch=await gmailGet(auth.access_token,'messages?'+new URLSearchParams({q,maxResults:'100',...(page?{pageToken:page}:{})}));
     for(const item of batch.messages??[]){const mail=await gmailGet(auth.access_token,'messages/'+item.id+'?format=full'),parsed=parseBankMail(mail);
      if(!parsed.reason&&parsed.amount===o.total_cop&&parsed.payer===normalizePayer(o.delivery_coverage?.paymentPayerName)&&+new Date(parsed.receivedAt)>=+new Date(o.created_at)-60000)matches.set(parsed.fingerprint,mail);
     }page=batch.nextPageToken;pages++;
    }while(page&&pages<5);
    if(page||matches.size>1){status='review';reason='Más de una notificación coincide; revisa el pago.';}
    else if(matches.size===1){const result=await reconcileBankMail(db,[...matches.values()][0],now,o.id);
     const current=(await db.query('SELECT status FROM orders WHERE id=$1',[o.id])).rows[0];status=current.status==='confirmed'?'matched':'review';reason=result.reason??(status==='review'?'El pago requiere revisión manual.':null);
    }
   }
  }catch(e){reason=e.message;error=reason;await db.query('UPDATE bank_mail_connection SET last_error=$1 WHERE id=1',[reason]);}
  if(status==='pending'&&job.attempts>=4){status='review';reason=reason??'No encontramos el pago después de cinco revisiones. El equipo debe verificarlo.';}
  const delay=[30,60,120,240][job.attempts]??240;
  await db.query('UPDATE bank_mail_checks SET status=$2,last_error=$3,next_check_at=$4 WHERE order_id=$1',[job.order_id,status,reason,new Date(Math.min(+new Date(job.deadline),+now+delay*1000)).toISOString()]);
 }
 await db.query('UPDATE bank_mail_connection SET checked_at=$1 WHERE id=1',[now.toISOString()]);
 if(!error)await db.query('UPDATE bank_mail_connection SET last_error=NULL WHERE id=1');
}
