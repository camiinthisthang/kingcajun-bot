import {randomUUID} from 'node:crypto';

const progress={new:'Tu pedido ya está en la cocina.',cooking:'Ya estamos preparando tu pedido.',ready:'Tu pedido está listo para despachar.',dispatched:'Tu pedido ya salió con el domiciliario.',served:'Registramos la entrega de tu pedido. ¡Gracias por elegir King Cajun!',cancelled:'La cancelación de tu pedido fue confirmada.',cancel_requested:'Recibimos tu solicitud de cancelación. Te avisaremos cuando cocina la confirme.'};
export async function enqueueTicketEvent(tx,t,event){
  const key=`ticket:${t.id}:v${t.version}:${event}`;
  if(['new','cancel_requested','cancelled'].includes(event))await tx.query(`INSERT INTO pos_jobs(id,ticket_id,kind,event_key,payload) VALUES($1,$2,'print',$3,$4::jsonb) ON CONFLICT(event_key) DO NOTHING`,[randomUUID(),t.id,`${key}:print`,JSON.stringify({ticket:t,event,copy:false})]);
  if(t.source_order_id&&progress[event]){
    const o=(await tx.query('SELECT o.public_id,c.phone_e164 FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1',[t.source_order_id])).rows[0];
    await tx.query(`INSERT INTO pos_jobs(id,ticket_id,kind,event_key,payload) VALUES($1,$2,'whatsapp',$3,$4::jsonb) ON CONFLICT(event_key) DO NOTHING`,[randomUUID(),t.id,`${key}:whatsapp`,JSON.stringify({phone:o.phone_e164,reference:o.public_id,status:event,text:progress[event],body:`King Cajun · ${o.public_id}\n${progress[event]}`})]);
  }
}

// Never automatically resend an ambiguous external delivery. A worker dying after
// a successful send cannot prove that the recipient/printer did not receive it.
export async function claimJobs(db,kind,limit=5){return db.transaction(async tx=>{
  await tx.query("UPDATE pos_jobs SET state='unknown',lease=NULL,last_error='Sin confirmación del adaptador; verifica antes de reenviar.' WHERE state='sending' AND next_at<now()");
  const rows=(await tx.query("SELECT * FROM pos_jobs WHERE kind=$1 AND state='pending' AND next_at<=now() ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED",[kind,limit])).rows;
  for(const row of rows){row.lease=randomUUID();await tx.query("UPDATE pos_jobs SET state='sending',lease=$2,attempts=attempts+1,next_at=now()+interval '2 minutes' WHERE id=$1",[row.id,row.lease]);}
  return rows;
});}
export async function finishJob(db,job,{state,providerId=null,error=null}){
  if(!['sent','spooled','printed','failed','pending','unknown','blocked','simulated'].includes(state))throw Error('Invalid job state');
  return db.query("UPDATE pos_jobs SET state=$3,provider_id=$4,last_error=$5,lease=NULL,next_at=now()+interval '1 minute',completed_at=CASE WHEN $3 IN ('sent','spooled','printed') THEN now() ELSE NULL END WHERE id=$1 AND lease=$2 AND state='sending'",[job.id,job.lease,state,providerId,error]);
}
export function createProgressDispatcher(db,send){let busy=false;return async()=>{
  if(busy)return;busy=true;
  try{for(const job of await claimJobs(db,'whatsapp')){
    // Only a real inbound user message opens the WhatsApp session. Conversation
    // timestamps can be advanced by outbound actions, so they are not authority.
    const latest=(await db.query("SELECT max(COALESCE((payload_json->>'sentAt')::timestamptz,received_at)) AS at FROM webhook_events WHERE provider='whatsapp' AND payload_json->>'phone'=$1",[job.payload.phone])).rows[0]?.at;
    const session=!!latest&&+new Date(latest)>Date.now()-23*3600000&&+new Date(latest)<=Date.now()+60000;
    try{const result=await send(job.payload,session);await finishJob(db,job,{state:result.messageId.startsWith('demo-')?'simulated':'sent',providerId:result.messageId});}
    catch(e){await finishJob(db,job,{state:e.code==='template_missing'?'blocked':e.retrySafe&&job.attempts<5?'pending':e.retrySafe?'failed':'unknown',error:e.message});}
  }}finally{busy=false;}
};}
