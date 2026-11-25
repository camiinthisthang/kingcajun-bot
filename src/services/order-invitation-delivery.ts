import type {Db} from '../db/index.js';
import type {Config} from '../config.js';
import {canUseBot} from '../lib/bot-access.js';
import {whatsappAddress} from '../lib/whatsapp-recipient.js';

// Only explicitly queued invitations are processed. Failed/ambiguous sends are
// never retried automatically, so a timeout cannot produce duplicate outreach.
export async function runQueuedOrderInvitations(db:Db,cfg:Config,now=new Date(),http:typeof fetch=fetch){
  if(cfg.BOT_MODE!=='ordering'||cfg.WHATSAPP_PROVIDER!=='360dialog')return 0;
  const due=(await db.query<any>(`SELECT m.*,c.phone_e164 FROM message_outbox m JOIN customers c ON c.id=m.customer_id
    WHERE m.kind='order_invitation' AND m.status='pending' AND m.due_at<=$1
      AND m.order_invitation_json->>'templateName' IS NOT NULL ORDER BY m.created_at LIMIT 20`,[now.toISOString()])).rows;
  if(!due.length)return 0;
  const headers={'D360-API-KEY':cfg.D360_API_KEY!,'Content-Type':'application/json'};
  const response=await http('https://waba-v2.360dialog.io/v1/configs/templates',{headers,signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Invitation template status lookup failed: '+response.status);
  const templates=(await response.json() as any).waba_templates??[];
  let sent=0;
  for(const candidate of due){
    if(!canUseBot(cfg,candidate.phone_e164))continue;
    const claimed=await db.transaction(async tx=>{
      const m=(await tx.query<any>("SELECT * FROM message_outbox WHERE id=$1 AND status='pending' FOR UPDATE",[candidate.id])).rows[0];
      if(!m)return null;
      const invitation=m.order_invitation_json;
      const stop=async(reason:string,status='cancelled')=>{await tx.query('UPDATE message_outbox SET status=$2,last_error=$3 WHERE id=$1',[m.id,status,reason]);return null;};
      if(invitation?.version!==1||invitation.deliveryZone!=='itagui'||!invitation.campaign||!invitation.authorizedAt||!/^[a-f0-9-]{36}$/i.test(invitation.windowId??''))return stop('Invalid queued invitation','failed');
      const route=(await tx.query<any>(`SELECT a.capacity,w.status,w.starts_at,w.order_cutoff_at,w.order_opens_at,
        (SELECT COUNT(*) FROM orders o WHERE o.delivery_window_id=w.id AND o.delivery_coverage->>'capacityZone'=a.zone
          AND COALESCE(o.delivery_coverage->>'method',o.delivery_coverage->>'preference',o.fulfillment_type,'delivery') NOT IN ('pickup','own_courier')
          AND (o.status IN ('confirmed','fulfilled','payment_review') OR (o.status='awaiting_payment' AND o.payment_expires_at>$3))) AS reserved
        FROM delivery_zone_allowances a JOIN delivery_windows w ON w.id=a.delivery_window_id WHERE a.zone=$1 AND w.id=$2`,[invitation.deliveryZone,invitation.windowId,now.toISOString()])).rows[0];
      if(!route||route.status!=='open'||+new Date(route.starts_at)<=+now+12*3600000||+new Date(route.order_cutoff_at)<=+now||Number(route.capacity)<=Number(route.reserved))return stop('The offered delivery route is closed, expired or full');
      if(route.order_opens_at&&+new Date(route.order_opens_at)>+now)return null;
      if((await tx.query('SELECT 1 FROM orders WHERE customer_id=$1 LIMIT 1',[m.customer_id])).rowCount)return stop('Customer now has an order; outreach cancelled');
      const control=(await tx.query<any>('SELECT * FROM whatsapp_chat_controls WHERE customer_phone=$1',[candidate.phone_e164])).rows[0];
      if(control&&(control.manual_paused_at||+new Date(control.paused_until)>+now)&&+new Date(control.updated_at)>+new Date(m.created_at))return stop('Staff intervened after outreach was queued');
      const template=templates.find((t:any)=>t.name===invitation.templateName&&t.language==='es_CO');
      const status=String(template?.status??'missing').toLowerCase();
      if(['rejected','disabled','paused','deleted'].includes(status))return stop('WhatsApp template '+status,'failed');
      if(status!=='approved'){
        await tx.query('UPDATE message_outbox SET last_error=$2 WHERE id=$1',[m.id,'Awaiting WhatsApp template approval; checked '+now.toISOString()]);return null;
      }
      if(template.components?.find((c:any)=>c.type==='BODY')?.text!==m.body)return stop('Approved template differs from the authorized message','failed');
      await tx.query("UPDATE message_outbox SET status='sending',attempts=attempts+1,last_error=NULL WHERE id=$1",[m.id]);
      return {...m,phone_e164:candidate.phone_e164};
    });
    if(!claimed)continue;
    try{
      const result=await http('https://waba-v2.360dialog.io/messages',{method:'POST',headers,body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',...whatsappAddress(claimed.phone_e164),type:'template',template:{name:claimed.order_invitation_json.templateName,language:{code:'es_CO'}}}),signal:AbortSignal.timeout(15000)});
      const body=await result.json() as any;
      if(!result.ok||!body.messages?.[0]?.id)throw new Error('WhatsApp invitation send failed: '+result.status+' '+JSON.stringify(body));
      await db.query("UPDATE message_outbox SET status='sent',provider_message_id=$2,sent_at=$3 WHERE id=$1",[claimed.id,body.messages[0].id,new Date().toISOString()]);sent++;
    }catch(error){
      await db.query("UPDATE message_outbox SET status='failed',last_error=$2 WHERE id=$1",[claimed.id,error instanceof Error?error.message:String(error)]);
    }
  }
  return sent;
}
