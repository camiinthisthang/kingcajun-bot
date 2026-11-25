import {randomUUID} from 'node:crypto';
import {requireValue} from './kitchen-domain.mjs';

export const openingTemplateName='kc_nuevos_cupos_lista_v1';
export const openingTemplateText='¡Hola! 🦀👑 Te escribimos porque te anotaste en la lista de espera de King Cajun.\n\nAbrimos nuevos cupos de entrega para {{1}}. Toca «Quiero pedir» para elegir tu pedido y consultar la disponibilidad. Los cupos se confirman con el pago completo; este aviso no reserva un cupo.\n\n¡Gracias por tu paciencia y por apoyarnos! ❤️\n\nSi no quieres recibir más avisos de nuevos cupos, toca «Salir de la lista».';
export const openingConsentText='Quiero recibir por WhatsApp avisos de King Cajun cuando abran nuevos cupos. Puedo salir de la lista en cualquier momento.';
export const openingTemplateDefinition={name:openingTemplateName,language:'es_CO',category:'MARKETING',components:[
 {type:'BODY',text:openingTemplateText,example:{body_text:[['sábado 24 de octubre, de 7:00 p. m. a 9:00 p. m.']]}},
 {type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'Quiero pedir'},{type:'QUICK_REPLY',text:'Salir de la lista'}]}
]};
export const openingMessage=dates=>openingTemplateText.replace('{{1}}',dates);

export async function recordOpeningDeliveryStatus(db,status){
 if(typeof status?.id!=='string'||!['failed','delivered','read'].includes(status.status))return;
 const failed=status.status==='failed';
 const codes=Array.isArray(status.errors)?status.errors.map(e=>Number(e?.code)).filter(Number.isFinite).join(', '):'';
 await db.query(`UPDATE opening_campaign_recipients r SET status=$2,last_error=$3,updated_at=now()
  FROM message_outbox m WHERE r.outbox_id=m.id AND m.kind='opening_announcement' AND m.provider_message_id=$1
  AND ($2='sent' OR NOT EXISTS(SELECT 1 FROM whatsapp_delivery_receipts d WHERE d.provider_message_id=$1))`,[status.id,failed?'failed':'sent',failed?'WhatsApp no pudo entregar el aviso'+(codes?' · '+codes:'')+'.':null]);
}

export async function migrateOpeningWaitlist(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS opening_waitlist (
  customer_id UUID PRIMARY KEY REFERENCES customers(id),status TEXT NOT NULL CHECK(status IN ('subscribed','withdrawn')),
  consent_at TIMESTAMPTZ NOT NULL,consent_event_id TEXT NOT NULL,consent_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS opening_waitlist_events (
  event_id TEXT PRIMARY KEY,customer_id UUID NOT NULL REFERENCES customers(id),action TEXT NOT NULL,
  consent_text TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS opening_waitlist_runtime (id INTEGER PRIMARY KEY CHECK(id=1),state_json JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS opening_campaigns (
  id UUID PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('draft','queued','blocked','completed','cancelled')),
  window_ids JSONB NOT NULL,dates_text TEXT NOT NULL,body TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,
  queued_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL,created_by TEXT NOT NULL,last_error TEXT);
 CREATE TABLE IF NOT EXISTS opening_campaign_recipients (
  campaign_id UUID NOT NULL REFERENCES opening_campaigns(id),customer_id UUID NOT NULL REFERENCES customers(id),
  consent_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain','skipped')),
  outbox_id UUID REFERENCES message_outbox(id),last_error TEXT,updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(campaign_id,customer_id));
 ALTER TABLE opening_campaigns ADD COLUMN IF NOT EXISTS include_paused BOOLEAN NOT NULL DEFAULT false;
 CREATE INDEX IF NOT EXISTS opening_campaign_due ON opening_campaign_recipients(campaign_id,status);`);
}

export async function setOpeningSubscription(db,{phone,eventId,subscribe,consentText=openingConsentText},now=new Date()){
 return db.transaction(async tx=>{
  const c=(await tx.query('SELECT id FROM customers WHERE phone_e164=$1 FOR UPDATE',[phone])).rows[0];
  requireValue(c,'Cliente no encontrado.',404);
  const previous=(await tx.query('SELECT * FROM opening_waitlist WHERE customer_id=$1',[c.id])).rows[0];
  const claimed=await tx.query(`INSERT INTO opening_waitlist_events(event_id,customer_id,action,consent_text,created_at)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,[eventId,c.id,subscribe?'subscribe':'withdraw',consentText,now.toISOString()]);
  if(!claimed.rowCount)return {duplicate:true,already:previous?.status==='subscribed'};
  if(subscribe){
   await tx.query(`INSERT INTO opening_waitlist(customer_id,status,consent_at,consent_event_id,consent_text,created_at,updated_at)
    VALUES($1,'subscribed',$2,$3,$4,$2,$2) ON CONFLICT(customer_id) DO UPDATE SET status='subscribed',
    consent_at=CASE WHEN opening_waitlist.status='subscribed' THEN opening_waitlist.consent_at ELSE excluded.consent_at END,
    consent_event_id=CASE WHEN opening_waitlist.status='subscribed' THEN opening_waitlist.consent_event_id ELSE excluded.consent_event_id END,consent_text=excluded.consent_text,updated_at=excluded.updated_at`,[c.id,now.toISOString(),eventId,consentText]);
  }else{
   await tx.query("UPDATE opening_waitlist SET status='withdrawn',updated_at=$2 WHERE customer_id=$1",[c.id,now.toISOString()]);
   await tx.query("UPDATE opening_campaign_recipients SET status='skipped',last_error='La persona salió de la lista.',updated_at=$2 WHERE customer_id=$1 AND status='pending'",[c.id,now.toISOString()]);
  }
  return {already:previous?.status==='subscribed'};
 });
}

export async function saveOpeningReadiness(db,state,now=new Date()){
 await db.query(`INSERT INTO opening_waitlist_runtime(id,state_json,updated_at) VALUES(1,$1::jsonb,$2)
 ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at`,[JSON.stringify(state),now.toISOString()]);
}
export async function openingReadiness(db,now=new Date()){
 const row=(await db.query('SELECT * FROM opening_waitlist_runtime WHERE id=1')).rows[0];
 const state=row?.state_json??{orderingOpen:false,templateStatus:'UNKNOWN',windows:[]};
 const fresh=!!row&&+now-+new Date(row.updated_at)<180000;
 const reasons=[];
 if(!fresh)reasons.push('Esperando una comprobación reciente del bot.');
 if(!state.orderingOpen)reasons.push('Los pedidos nuevos siguen cerrados.');
 if(state.templateStatus!=='APPROVED')reasons.push('El aviso de WhatsApp aún no está aprobado o no pudo verificarse.');
 if(!state.windows?.length)reasons.push('No hay franjas de entrega disponibles para anunciar.');
 return {...state,fresh,checkedAt:row?.updated_at??null,ready:reasons.length===0,reasons};
}
export async function readOpeningWaitlist(db){
 const [readiness,subscribers,campaigns]=await Promise.all([
  openingReadiness(db),
  db.query(`SELECT l.*,c.display_name,c.phone_e164 FROM opening_waitlist l JOIN customers c ON c.id=l.customer_id ORDER BY l.consent_at DESC`),
  db.query(`SELECT k.*,COUNT(r.customer_id)::int AS total,
   COUNT(*) FILTER(WHERE r.status='sent')::int AS sent,COUNT(*) FILTER(WHERE d.delivered_at IS NOT NULL)::int AS delivered,
   COUNT(*) FILTER(WHERE r.status='pending')::int AS pending,COUNT(*) FILTER(WHERE r.status='sending')::int AS sending,
   COUNT(*) FILTER(WHERE r.status IN ('failed','uncertain'))::int AS failed,COUNT(*) FILTER(WHERE r.status='skipped')::int AS skipped
   FROM opening_campaigns k LEFT JOIN opening_campaign_recipients r ON r.campaign_id=k.id
   LEFT JOIN message_outbox m ON m.id=r.outbox_id LEFT JOIN whatsapp_delivery_receipts d ON d.provider_message_id=m.provider_message_id
   GROUP BY k.id ORDER BY k.created_at DESC LIMIT 30`)
 ]);
 return {readiness,subscribers:subscribers.rows,campaigns:campaigns.rows,templateText:openingTemplateText,templateName:openingTemplateName};
}
function selectedWindows(state,ids){
 requireValue(Array.isArray(ids)&&ids.length>0&&ids.length<=20&&ids.every(id=>typeof id==='string'),'Selecciona al menos una franja.');
 const windows=state.windows.filter(w=>ids.includes(w.id));
 requireValue(windows.length===new Set(ids).size,'Una de las franjas ya no está disponible. Actualiza y revisa el aviso.',409);
 const dates=windows.map(w=>w.label.replace(/\.+$/,'')).join('; ');
 requireValue(dates.length<=600,'Selecciona menos franjas para que el aviso sea legible.');
 return {ids:windows.map(w=>w.id).sort(),dates};
}
export async function prepareOpeningCampaign(db,input,actor,now=new Date()){
 return db.transaction(async tx=>{
  const state=await openingReadiness(tx,now);
  requireValue(state.fresh&&state.orderingOpen,'Primero hay que abrir pedidos y configurar fechas disponibles.',409);
  const {ids,dates}=selectedWindows(state,input?.windowIds);
  const id=randomUUID();
  await tx.query(`INSERT INTO opening_campaigns(id,status,window_ids,dates_text,body,created_at,updated_at,created_by)
   VALUES($1,'draft',$2::jsonb,$3,$4,$5,$5,$6)`,[id,JSON.stringify(ids),dates,openingMessage(dates),now.toISOString(),actor]);
  await tx.query(`INSERT INTO opening_campaign_recipients(campaign_id,customer_id,consent_at,status,updated_at)
   SELECT $1,customer_id,consent_at,'pending',$2 FROM opening_waitlist WHERE status='subscribed'`,[id,now.toISOString()]);
  return openingCampaignDetail(tx,id);
 });
}
export async function openingCampaignDetail(db,id){
 const campaign=(await db.query('SELECT * FROM opening_campaigns WHERE id=$1',[id])).rows[0];
 requireValue(campaign,'Aviso no encontrado.',404);
 const recipients=(await db.query(`SELECT r.*,c.display_name,c.phone_e164,l.status AS subscription_status,
  m.provider_message_id,d.delivered_at FROM opening_campaign_recipients r JOIN customers c ON c.id=r.customer_id
  JOIN opening_waitlist l ON l.customer_id=r.customer_id LEFT JOIN message_outbox m ON m.id=r.outbox_id
  LEFT JOIN whatsapp_delivery_receipts d ON d.provider_message_id=m.provider_message_id WHERE r.campaign_id=$1 ORDER BY c.display_name,c.phone_e164`,[id])).rows;
 return {...campaign,recipients};
}
export async function queueOpeningCampaign(db,id,input,now=new Date()){
 requireValue(input?.confirm===true,'Revisa el mensaje y confirma el envío.');
 return db.transaction(async tx=>{
  // One queue at a time, including concurrent clicks from different browsers.
  await tx.query('SELECT id FROM opening_waitlist_runtime WHERE id=1 FOR UPDATE');
  const campaign=(await tx.query('SELECT * FROM opening_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
  requireValue(campaign,'Aviso no encontrado.',404);
  if(campaign.status==='queued')return {id,status:'queued'};
  requireValue(['draft','blocked'].includes(campaign.status),'Este aviso ya terminó o fue cancelado. Revisa su resultado antes de preparar otro.',409);
  const state=await openingReadiness(tx,now);requireValue(state.ready,state.reasons.join(' '),409);
  const selected=selectedWindows(state,campaign.window_ids);
  requireValue(openingMessage(selected.dates)===campaign.body,'Las fechas cambiaron. Prepara y revisa otro aviso.',409);
  requireValue(campaign.status==='blocked'||+now-+new Date(campaign.created_at)<15*60000,'La revisión venció. Prepara un aviso actualizado.',409);
  const duplicate=(await tx.query(`SELECT id FROM opening_campaigns WHERE id<>$1 AND (status='queued' OR
   (status IN ('completed','blocked','cancelled') AND queued_at>$2 AND window_ids=$3::jsonb)) LIMIT 1`,[id,new Date(+now-24*3600000).toISOString(),JSON.stringify(campaign.window_ids)])).rows[0];
  requireValue(!duplicate,'Ya existe un envío activo o reciente para esas franjas. Revisa su resultado para evitar mensajes duplicados.',409);
  await tx.query(`UPDATE opening_campaign_recipients r SET status='skipped',last_error='La suscripción cambió después de la revisión.',updated_at=$2
   FROM opening_waitlist l WHERE r.campaign_id=$1 AND r.customer_id=l.customer_id AND r.status='pending'
   AND (l.status<>'subscribed' OR l.consent_at<>r.consent_at)`,[id,now.toISOString()]);
  const count=(await tx.query("SELECT COUNT(*)::int AS n FROM opening_campaign_recipients WHERE campaign_id=$1 AND status='pending'",[id])).rows[0].n;
  requireValue(count>0,'No hay personas suscritas para este aviso.');
  await tx.query("UPDATE opening_campaigns SET status='queued',queued_at=$2,updated_at=$2,last_error=NULL WHERE id=$1",[id,now.toISOString()]);
  return {id,status:'queued',recipients:count};
 });
}
export async function cancelOpeningCampaign(db,id,now=new Date()){
 return db.transaction(async tx=>{
  const changed=await tx.query("UPDATE opening_campaigns SET status='cancelled',updated_at=$2 WHERE id=$1 AND status IN ('draft','queued','blocked') RETURNING id",[id,now.toISOString()]);
  requireValue(changed.rowCount,'Este aviso ya terminó o no existe.',409);
  await tx.query("UPDATE opening_campaign_recipients SET status='skipped',last_error='Envío detenido por el equipo.',updated_at=$2 WHERE campaign_id=$1 AND status='pending'",[id,now.toISOString()]);
  return {id,status:'cancelled'};
 });
}
