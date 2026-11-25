import {randomUUID} from 'node:crypto';
import {openingTemplateName,openingTemplateText,saveOpeningReadiness} from '../../admin-dashboard/src/opening-waitlist.mjs';
import {isChatPaused} from '../../admin-dashboard/src/staff-confirmations.mjs';
import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import {publicBotOpen,canUseBot} from '../lib/bot-access.js';
import {whatsappAddress} from '../lib/whatsapp-recipient.js';
import {windowLabel} from '../lib/format.js';

type Window={id:string;starts_at:string;ends_at:string;remaining:number};
export class OpeningWaitlistService {
 private running=false;
 constructor(private db:Db,private cfg:Config,private windows:()=>Promise<Window[]>,private http:typeof fetch=fetch){}
 private headers(){return {'D360-API-KEY':this.cfg.D360_API_KEY,'Content-Type':'application/json'};}
 async templateStatus(){
  if(this.cfg.WHATSAPP_PROVIDER!=='360dialog')return 'UNAVAILABLE';
  for(let offset=0;offset<500;offset+=100){
   const response=await this.http(`https://waba-v2.360dialog.io/v1/configs/templates?limit=100&offset=${offset}`,{headers:this.headers(),signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('No se pudo verificar la plantilla: HTTP '+response.status);
   const data=await response.json() as any,templates=data.waba_templates??data.data??[];
   const template=templates.find((t:any)=>t.name===openingTemplateName&&t.language==='es_CO');
   if(template){
    const components=template.components??[];
    const buttons=components.find((c:any)=>c.type?.toUpperCase()==='BUTTONS')?.buttons??[];
    if(components.find((c:any)=>c.type?.toUpperCase()==='BODY')?.text!==openingTemplateText||buttons.length!==2||buttons[0].text!=='Quiero pedir'||buttons[1].text!=='Salir de la lista'||buttons.some((b:any)=>b.type?.toUpperCase()!=='QUICK_REPLY'))return 'CONTENT_MISMATCH';
    return String(template.status??'UNKNOWN').toUpperCase();
   }
   if(templates.length<100)return 'NOT_SUBMITTED';
  }
  return 'UNKNOWN';
 }
 async runDue(now=new Date()){
  if(this.running)return {sent:0};this.running=true;
  let sent=0;
  try{
   const orderingOpen=this.cfg.BOT_MODE==='ordering'&&!this.cfg.NEW_ORDERS_PAUSED&&publicBotOpen(this.cfg);
   const windows=orderingOpen?await this.windows():[];
   let templateStatus='UNKNOWN',error:string|null=null;
   try{templateStatus=await this.templateStatus();}catch(e){error=e instanceof Error?e.message:'No se pudo verificar WhatsApp.';}
   await saveOpeningReadiness(this.db,{orderingOpen,templateStatus,error,windows:windows.filter(w=>w.remaining>0).map(w=>({id:w.id,label:windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE),startsAt:w.starts_at,endsAt:w.ends_at}))},now);
   // A crash after POST may already have delivered. Never automatically retry it.
   await this.db.query(`UPDATE opening_campaign_recipients SET status='uncertain',last_error='Envío interrumpido: revisar el chat antes de reenviar.',updated_at=$1
    WHERE status='sending' AND updated_at<$2`,[now.toISOString(),new Date(+now-5*60000).toISOString()]);
   const campaign=(await this.db.query<any>("SELECT * FROM opening_campaigns WHERE status='queued' AND queued_at <= $1 ORDER BY queued_at LIMIT 1",[now.toISOString()])).rows[0];
   if(!campaign)return {sent};
   const blocked=async(reason:string)=>{await this.db.query("UPDATE opening_campaigns SET status='blocked',last_error=$2,updated_at=now() WHERE id=$1 AND status='queued'",[campaign.id,reason]);};
   if(!orderingOpen||templateStatus!=='APPROVED'){
    await blocked(!orderingOpen?'Los pedidos están cerrados. No se enviaron más avisos.':'La plantilla no está aprobada o no pudo verificarse.');return {sent};
   }
   if(+now-+new Date(campaign.queued_at)>2*3600000){await blocked('El envío venció. Revisa las fechas y sus resultados antes de preparar otro.');return {sent};}
   const due=(await this.db.query<any>(`SELECT r.*,c.phone_e164 FROM opening_campaign_recipients r JOIN customers c ON c.id=r.customer_id
    WHERE campaign_id=$1 AND r.status='pending' ORDER BY r.customer_id LIMIT 10`,[campaign.id])).rows;
   for(const candidate of due){
    const current=await this.windows();
    if(!campaign.window_ids.every((id:string)=>current.some(w=>w.id===id&&w.remaining>0))){await blocked('Una franja anunciada se llenó o cerró. Se detuvo el resto del envío.');break;}
    const currentDates=current.filter(w=>campaign.window_ids.includes(w.id)).map(w=>windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE).replace(/\.+$/,'')).join('; ');
    if(currentDates!==campaign.dates_text){await blocked('Cambió una fecha u horario del aviso. Revisa el mensaje antes de enviar más.');break;}
    const claimed=await this.db.transaction(async tx=>{
     // Serialize cancellation/queue changes with the recipient claim.
     const c=(await tx.query<any>('SELECT status FROM opening_campaigns WHERE id=$1 FOR UPDATE',[campaign.id])).rows[0];
     if(c?.status!=='queued')return null;
     const l=(await tx.query<any>('SELECT * FROM opening_waitlist WHERE customer_id=$1 FOR UPDATE',[candidate.customer_id])).rows[0];
     const row=(await tx.query<any>("SELECT * FROM opening_campaign_recipients WHERE campaign_id=$1 AND customer_id=$2 AND status='pending' FOR UPDATE",[campaign.id,candidate.customer_id])).rows[0];
     if(!row)return null;
     const skip=async(reason:string)=>{await tx.query("UPDATE opening_campaign_recipients SET status='skipped',last_error=$3,updated_at=now() WHERE campaign_id=$1 AND customer_id=$2",[campaign.id,row.customer_id,reason]);return null;};
     if(l?.status!=='subscribed'||+new Date(l.consent_at)!==+new Date(row.consent_at))return skip('La suscripción cambió o fue retirada.');
     if(!canUseBot(this.cfg,candidate.phone_e164))return skip('El destinatario no está habilitado.');
     if(!campaign.include_paused&&await isChatPaused(tx,candidate.phone_e164))return skip('El equipo tiene la conversación pausada.');
     const id=randomUUID();
     await tx.query(`INSERT INTO message_outbox(id,customer_id,kind,body,due_at,status,attempts,created_at)
      VALUES($1,$2,'opening_announcement',$3,now(),'sending',1,now())`,[id,row.customer_id,campaign.body]);
     await tx.query("UPDATE opening_campaign_recipients SET status='sending',outbox_id=$3,updated_at=now() WHERE campaign_id=$1 AND customer_id=$2",[campaign.id,row.customer_id,id]);
     return {outboxId:id,phone:candidate.phone_e164,customerId:row.customer_id};
    });
    if(!claimed)continue;
    let result:{messageId:string}|undefined,sendFailure:string|undefined,uncertain=false;
    try{
     // One POST only: timeouts and interrupted responses are not safe to retry.
     const response=await this.http('https://waba-v2.360dialog.io/messages',{method:'POST',headers:this.headers(),signal:AbortSignal.timeout(15000),body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',...whatsappAddress(claimed.phone),type:'template',template:{name:openingTemplateName,language:{code:'es_CO'},components:[
      {type:'body',parameters:[{type:'text',text:campaign.dates_text}]},
      {type:'button',sub_type:'quick_reply',index:'0',parameters:[{type:'payload',payload:'kc:opening_order'}]},
      {type:'button',sub_type:'quick_reply',index:'1',parameters:[{type:'payload',payload:'kc:opening_leave'}]}
     ]}})});
     const data=await response.json() as any;
     if(response.ok&&data.messages?.[0]?.id)result={messageId:data.messages[0].id};
     else {uncertain=response.ok||response.status>=500;sendFailure=`WhatsApp HTTP ${response.status}${data.error?.code?' · '+data.error.code:''}. ${uncertain?'Verificar el chat antes de reenviar.':'El proveedor rechazó el mensaje.'}`;}
    }catch{uncertain=true;sendFailure='Respuesta de WhatsApp desconocida. Verificar el chat antes de reenviar.';}
    // If this database write fails, leave sending: recovery marks it uncertain.
    await this.db.transaction(async tx=>{
     await tx.query("UPDATE message_outbox SET status=$2,provider_message_id=$3,sent_at=$4,last_error=$5 WHERE id=$1",[claimed.outboxId,result?'sent':'failed',result?.messageId??null,result?new Date().toISOString():null,sendFailure??null]);
     await tx.query('UPDATE opening_campaign_recipients SET status=$3,last_error=$4,updated_at=now() WHERE campaign_id=$1 AND customer_id=$2',[campaign.id,claimed.customerId,result?'sent':uncertain?'uncertain':'failed',sendFailure??null]);
    });
    if(result)sent++;
   }
   await this.db.query(`UPDATE opening_campaigns k SET status='completed',updated_at=now() WHERE id=$1 AND status='queued'
    AND NOT EXISTS(SELECT 1 FROM opening_campaign_recipients r WHERE r.campaign_id=k.id AND r.status IN ('pending','sending'))`,[campaign.id]);
   return {sent};
  }finally{this.running=false;}
 }
}
