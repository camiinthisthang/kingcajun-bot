import {DateTime} from 'luxon';
import {locationCheck} from '../../admin-dashboard/src/location-confirmation.mjs';
import {knownDeliveryContactDetails,needsDeliveryContacts} from './delivery-contacts.js';
import {queueConfirmationFollowups,recordReminderDelivery} from '../../admin-dashboard/src/reminder-confirmations.mjs';
import {isChatPaused} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {withPendingTransferDetails} from './full-payment.js';
import {runQueuedOrderInvitations} from './order-invitation-delivery.js';
import type { Db } from '../db/index.js';
import type { WhatsAppProvider } from '../providers/whatsapp.js';
import type { Config } from '../config.js';
import { windowLabel } from '../lib/format.js';
import { allowedWhatsAppNumbers, publicBotOpen } from '../lib/bot-access.js';
import {reminderButtons,reminderButtonTemplateText} from './reminder-actions.js';

export class ReminderService {
  private running = false;
  constructor(private readonly db: Db, private readonly provider: WhatsAppProvider, private readonly cfg: Config) {}

  async runDue(now=new Date()) {
    if (this.cfg.BOT_MODE !== 'ordering' || this.running) return { sent: 0 };
    this.running = true;
    let sent = 0;
    try {
      try { sent+=await runQueuedOrderInvitations(this.db,this.cfg,now); }
      catch(error){ console.error('Queued invitation check failed',error instanceof Error?error.message:String(error)); }
      // Retry committed order receipts separately from template reminders. Never
      // create another order, and stop after four attempts / the messaging window.
      const receipts=(await this.db.query<any>(`SELECT m.*,c.phone_e164 FROM message_outbox m JOIN customers c ON c.id=m.customer_id LEFT JOIN orders o ON o.id=m.order_id
        WHERE m.kind IN ('order_confirmation','reservation_instructions','deposit_confirmation','staff_order_confirmation','staff_resume','extras_payment_request','creator_submission') AND m.status IN ('failed','pending') AND m.attempts<4
        AND m.created_at > $1 AND (m.kind IN ('staff_resume','creator_submission') OR o.status IN ('confirmed','awaiting_payment'))
        AND ($2=FALSE OR c.phone_e164=ANY($3::text[])) ORDER BY m.created_at LIMIT 20`,[new Date(Date.now()-23*3600000).toISOString(),!publicBotOpen(this.cfg),allowedWhatsAppNumbers(this.cfg)])).rows;
      for(const receipt of receipts){
        if(receipt.kind==='creator_submission'){
          const chat=(await this.db.query<any>('SELECT context_json FROM conversations WHERE phone_e164=$1',[receipt.phone_e164])).rows[0];
          if(!chat?.context_json.creatorSubmission||(!receipt.body.includes('revisará tu propuesta')&&chat.context_json.creatorSubmission.acknowledged)){
            await this.db.query("UPDATE message_outbox SET status='cancelled' WHERE id=$1",[receipt.id]);continue;
          }
        }
        if(receipt.kind==='extras_payment_request'){
          const pending=(await this.db.query("SELECT reference FROM order_extras WHERE order_id=$1 AND status='pending' AND expires_at>$2",[receipt.order_id,now.toISOString()])).rows[0];
          if(!pending||!receipt.body.includes(String(pending.reference))){await this.db.query("UPDATE message_outbox SET status='cancelled' WHERE id=$1",[receipt.id]);continue;}
        }
        if(receipt.kind==='staff_resume'){
          const chat=(await this.db.query<any>('SELECT state,updated_at FROM conversations WHERE phone_e164=$1',[receipt.phone_e164])).rows[0];
          if(!chat||chat.state==='HUMAN_HANDOFF'||+new Date(chat.updated_at)>+new Date(receipt.created_at)){
            await this.db.query("UPDATE message_outbox SET status='cancelled' WHERE id=$1 AND status IN ('pending','failed')",[receipt.id]);continue;
          }
        }
        if(receipt.kind!=='staff_order_confirmation'&&await isChatPaused(this.db,receipt.phone_e164,now))continue;
        const claim=await this.db.query("UPDATE message_outbox SET status='sending',attempts=attempts+1 WHERE id=$1 AND status IN ('failed','pending') RETURNING id",[receipt.id]);if(!claim.rowCount)continue;
        try{
          if(['staff_order_confirmation','order_confirmation','reservation_instructions'].includes(receipt.kind)&&receipt.order_id){
            receipt.body=await withPendingTransferDetails(this.db,this.cfg,receipt.order_id,receipt.body,now);
            await this.db.query('UPDATE message_outbox SET body=$2 WHERE id=$1',[receipt.id,receipt.body]);
          }
          const result=receipt.kind==='staff_resume'&&receipt.buttons_json?.length?await this.provider.sendButtons(receipt.phone_e164,receipt.body,receipt.buttons_json):await this.provider.sendText(receipt.phone_e164,receipt.body);await this.db.query("UPDATE message_outbox SET status='sent',provider_message_id=$2,sent_at=$3 WHERE id=$1",[receipt.id,result.messageId,new Date().toISOString()]);sent++;
        }
        catch(error){await this.db.query("UPDATE message_outbox SET status='failed',last_error=$2 WHERE id=$1",[receipt.id,error instanceof Error?error.message:String(error)]);}
      }
      await queueConfirmationFollowups(this.db,now,publicBotOpen(this.cfg)?null:allowedWhatsAppNumbers(this.cfg));
      const due = (await this.db.query<any>(`
        SELECT m.*, m.id::text,parent.location_check_json AS parent_location_check, c.phone_e164, o.public_id, o.fulfillment_type, o.delivery_address, o.delivery_coverage, o.reminder_confirmation_required,
               w.starts_at, w.ends_at
        FROM message_outbox m LEFT JOIN message_outbox parent ON parent.id=m.reminder_parent_id JOIN customers c ON c.id = m.customer_id
        JOIN orders o ON o.id = m.order_id
        JOIN delivery_windows w ON w.id = o.delivery_window_id
        WHERE m.kind IN ('reminder_24h','reminder_6h','reminder_followup_12h') AND m.status = 'pending' AND m.due_at <= $1 AND o.status = 'confirmed' AND COALESCE((o.delivery_coverage->>'needsReview')::boolean,FALSE)=FALSE AND w.starts_at > $1
          AND (m.kind<>'reminder_followup_12h' OR (parent.confirmation_received_at IS NULL AND parent.status='sent' AND parent.confirmation_deadline_at<=$1))
          AND ($2 = FALSE OR c.phone_e164 = ANY($3::text[]))
        ORDER BY m.due_at LIMIT 50
      `, [now.toISOString(), !publicBotOpen(this.cfg), allowedWhatsAppNumbers(this.cfg)])).rows;
      for (const message of due) {
        // Confirmed-order reminders remain scheduled during a manual AI pause.
        // The pause still blocks normal conversation and unrequested sales replies.
        const claimed = await this.db.query(`
          UPDATE message_outbox SET status = 'sending', attempts = attempts + 1
          WHERE id = $1 AND status = 'pending' RETURNING id
        `, [message.id]);
        if (!claimed.rowCount) continue;
        try {
          const method=message.delivery_coverage?.method??message.delivery_coverage?.preference??message.fulfillment_type;
          const action = ['pickup','own_courier'].includes(method)?'Recogida en King Cajun: Calle 3S #43A-40, El Poblado, Medellín.':String(message.delivery_address||'').replace(/\s+/g,' ').trim();
          const needsConfirmation=message.reminder_confirmation_required===true;
          const details=await knownDeliveryContactDetails(this.db,message.phone_e164),contacts=details.phones;
          if((contacts.length===2||details.singleAccepted)&&(message.delivery_coverage?.contactPhones?.length??0)<2)await this.db.query("UPDATE orders SET delivery_coverage=COALESCE(delivery_coverage,'{}'::jsonb)||jsonb_build_object('contactPhones',$2::jsonb,'singleContactAccepted',$3::boolean) WHERE id=$1",[message.order_id,JSON.stringify(contacts),details.singleAccepted]);
          const contactRequest=needsDeliveryContacts({deliveryContactPhones:contacts,deliverySingleContactAccepted:details.singleAccepted})?(details.singleAccepted?'Envíanos tu único número de contacto.':contacts.length===1?'Envíanos otro número diferente de contacto. Si solo tienes uno, dínoslo.':'Envíanos dos números de contacto diferentes. Si solo tienes uno, dínoslo.'):'';
          const check=message.kind==='reminder_followup_12h'?message.parent_location_check:message.kind==='reminder_24h'&&!['pickup','own_courier'].includes(method??message.delivery_coverage?.preference??message.fulfillment_type)?locationCheck(message):null;
          const instruction=[message.kind==='reminder_followup_12h'?'Aún nos falta tu confirmación. Gracias por tu apoyo. 👑':'Gracias por tu apoyo. 👑',message.kind==='reminder_6h'?contactRequest:''].filter(Boolean).join(' ');
          const pickupAt=message.delivery_coverage?.pickupArrival?.estimatedAt;
          const date=['pickup','own_courier'].includes(method)&&pickupAt?DateTime.fromISO(pickupAt).setZone(this.cfg.BUSINESS_TIMEZONE).setLocale('es-CO').toFormat("cccc d 'de' LLLL 'a las' h:mm a"):windowLabel(message.starts_at,message.ends_at,this.cfg.BUSINESS_TIMEZONE);
          const detail=(message.kind==='reminder_followup_12h'&&check?check.sourceAddress:action)+(check?' Mapa: '+check.url:'');
          const parameters=message.kind!=='reminder_6h'?[message.public_id,date,detail,instruction]:[message.public_id,date,detail+` Responde CONFIRMO ${message.public_id} 6H. `+instruction];
          const body=message.kind!=='reminder_6h'?reminderButtonTemplateText.replace(/\{\{([1-4])\}\}/g,(_,n)=>parameters[Number(n)-1]!):`⏰ Pedido ${message.public_id}\n${date}\n${parameters[2]}`;
          const buttons=message.kind!=='reminder_6h'?reminderButtons(message.reminder_parent_id??message.id):null;
          const latest=(await this.db.query<any>("SELECT max(COALESCE((payload_json->>'sentAt')::timestamptz,received_at)) AS at FROM webhook_events WHERE provider='whatsapp' AND payload_json->>'phone'=$1",[message.phone_e164])).rows[0]?.at;
          const sessionOpen=!!latest&&+new Date(latest)>+now-23*3600000&&+new Date(latest)<=+now+60000;
          await this.db.query('UPDATE message_outbox SET body=$2,confirmation_required=$3,location_check_json=$4::jsonb,buttons_json=$5::jsonb WHERE id=$1',[message.id,body,needsConfirmation,check?JSON.stringify(check):null,buttons?JSON.stringify(buttons):null]);
          const result = await this.provider.sendReminder(
            message.phone_e164,
            message.kind==='reminder_6h'?'reminder_6h':'reminder_24h',
            body,
            parameters,
            buttons?{buttons,sessionOpen}:undefined
          );
          await this.db.query(`UPDATE message_outbox SET status = 'sent', provider_message_id = $1, sent_at = $2,body=$4,extras_offered=FALSE,buttons_json=$5::jsonb,last_error=NULL WHERE id = $3`, [result.messageId, new Date().toISOString(), message.id,result.body??body,result.buttonsSent&&buttons?JSON.stringify(buttons):null]);
          {
            if(this.cfg.WHATSAPP_PROVIDER==='demo')await recordReminderDelivery(this.db,result.messageId,now);
            else {const receipt=(await this.db.query('SELECT delivered_at FROM whatsapp_delivery_receipts WHERE provider_message_id=$1',[result.messageId])).rows[0];if(receipt)await recordReminderDelivery(this.db,result.messageId,receipt.delivered_at);}
          }
          sent++;
        } catch (error) {
          await this.db.query(`UPDATE message_outbox SET status = 'pending', last_error = $1 WHERE id = $2`, [error instanceof Error ? error.message : String(error), message.id]);
        }
      }
      return {sent};
    } finally {
      this.running = false;
    }
  }
}
