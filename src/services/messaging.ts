import {repeatsReply} from './repeated-reply.js';
import { randomUUID } from 'node:crypto';
import {isChatPaused} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {limitBarrioRequest} from './barrio-clarification.js';
import type { DbClient } from '../db/index.js';
import type { WhatsAppProvider } from '../providers/whatsapp.js';
import type {OrderInvitation} from './order-invitations.js';

export class MessagingService {
  constructor(private readonly db: DbClient, private readonly provider: WhatsAppProvider, private readonly paymentQrUrl?:string) {}

  withDb(db: DbClient) { return new MessagingService(db, this.provider, this.paymentQrUrl); }

  async sendNow(phone: string, body: string, kind = 'conversation', orderId?: string) {
    const result=await this.sendAndRecord(phone, body, kind, orderId, undefined);
    await this.attachPaymentQr(phone,body,result);return result;
  }

  // Explicit operator outreach only. Recording the offer with the sent message
  // lets a later customer acceptance opt into ordering without a menu detour.
  async sendOrderInvitationNow(phone:string,body:string,invitation:OrderInvitation){
    if(invitation.version!==1||invitation.deliveryZone!=='itagui'||invitation.acceptedEventId)throw new Error('Invitación inválida');
    const active=await this.db.query(`SELECT 1 FROM delivery_zone_allowances a JOIN delivery_windows w ON w.id=a.delivery_window_id
      WHERE a.zone=$1 AND w.id=$2 AND a.capacity>0 AND w.status='open' AND w.starts_at>now()+interval '12 hours'
        AND w.order_cutoff_at>now() AND (w.order_opens_at IS NULL OR w.order_opens_at<=now())
        AND a.capacity>(SELECT COUNT(*) FROM orders o WHERE o.delivery_window_id=w.id AND o.delivery_coverage->>'capacityZone'=a.zone
          AND COALESCE(o.delivery_coverage->>'method',o.delivery_coverage->>'preference',o.fulfillment_type,'delivery') NOT IN ('pickup','own_courier')
          AND (o.status IN ('confirmed','fulfilled','payment_review') OR (o.status='awaiting_payment' AND o.payment_expires_at>now())))`,[invitation.deliveryZone,invitation.windowId]);
    if(!active.rowCount)throw new Error('La ruta de esta invitación ya no está abierta');
    await this.db.query(`INSERT INTO customers(id,phone_e164,locale,created_at,updated_at) VALUES($1,$2,'es-CO',now(),now()) ON CONFLICT(phone_e164) DO NOTHING`,[randomUUID(),phone]);
    return this.sendAndRecord(phone,body,'order_invitation',undefined,undefined,undefined,invitation);
  }

  async sendImageNow(phone: string, imageUrl: string, caption: string, kind = 'menu_image') {
    return this.sendAndRecord(phone, caption, kind, undefined, imageUrl);
  }

  async sendButtonsNow(phone: string, body: string, buttons: Array<{ id: string; title: string }>, kind='main_menu', orderId?:string) {
    const result=await this.sendAndRecord(phone, body, kind, orderId, undefined, buttons);
    await this.attachPaymentQr(phone,body,result);return result;
  }

  private async attachPaymentQr(phone:string,body:string,result:any) {
    if(this.paymentQrUrl&&!result.suppressed&&body.includes('Llave Bre-B: 0000000000'))
      await this.sendImageNow(phone,this.paymentQrUrl,'Paga a King Cajun con este QR. Llave Bre-B: 0000000000. Envía el comprobante por este chat; confirmaremos cuando verifiquemos el pago.','payment_qr');
  }

  async sendPaymentAlertNow(phone: string, body: string, parameters: string[], orderId: string) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(`
      INSERT INTO operational_notifications (id, order_id, recipient_phone, kind, body, status, created_at)
      VALUES ($1, $2, $3, 'payment_alert', $4, 'sending', $5)
    `, [id, orderId, phone, body, now]);
    try {
      const sent = await this.provider.sendPaymentAlert(phone, body, parameters);
      await this.db.query(`UPDATE operational_notifications SET status = 'sent', attempts = 1, provider_message_id = $1, sent_at = $2 WHERE id = $3`, [sent.messageId, new Date().toISOString(), id]);
      return sent;
    } catch (error) {
      await this.db.query(`UPDATE operational_notifications SET status = 'failed', attempts = 1, last_error = $1 WHERE id = $2`, [error instanceof Error ? error.message : String(error), id]);
      throw error;
    }
  }

  private async sendAndRecord(phone: string, body: string, kind: string, orderId?: string, mediaUrl?: string, buttons?: Array<{ id: string; title: string }>, invitation?:OrderInvitation) {
    // Recheck after an AI request too: staff may have paused while it was running.
    if(!['staff_order_confirmation','reminder_transactional','reminder_contact_request','opening_subscription'].includes(kind)&&!invitation&&await isChatPaused(this.db,phone))return {suppressed:true};
    body=await limitBarrioRequest(this.db,phone,body);
    const customer = (await this.db.query<{ id: string }>('SELECT id::text FROM customers WHERE phone_e164 = $1', [phone])).rows[0];
    if (!customer) throw new Error(`Customer not found for ${phone}`);
    // Transactional notices and requested media retain their own delivery rules.
    // Conversational loops pause silently; staff can resume with sigue.
    if(!orderId&&!mediaUrl&&!invitation&&!['scheduled_order_flow','pos_conversation','opening_subscription','staff_order_confirmation','reminder_transactional','reminder_contact_request'].includes(kind)){
      const recent=(await this.db.query<{body:string}>(`SELECT body FROM message_outbox WHERE customer_id=$1 AND status='sent'
        AND order_id IS NULL AND media_url IS NULL AND sent_at>now()-interval '24 hours'
        AND sent_at>COALESCE((SELECT MAX(created_at) FROM orders WHERE customer_id=$1),'-infinity'::timestamptz)
        AND sent_at>COALESCE((SELECT updated_at FROM whatsapp_chat_controls WHERE customer_phone=$2 AND manual_paused_at IS NULL),'-infinity'::timestamptz)
        ORDER BY sent_at DESC LIMIT 20`,[customer.id,phone])).rows;
      if(recent.some(row=>repeatsReply(body,row.body))){
        await this.db.query(`INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,manual_paused_at,updated_at,updated_by)
          VALUES($1,now(),now(),now(),'automatic-repeat-guard') ON CONFLICT(customer_phone) DO UPDATE
          SET manual_paused_at=now(),updated_at=now(),updated_by='automatic-repeat-guard'`,[phone]);
        return {suppressed:true};
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(`
      INSERT INTO message_outbox (id, customer_id, order_id, kind, body, media_url, due_at, status, created_at, buttons_json,order_invitation_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending', $7, $8::jsonb,$9::jsonb)
    `, [id, customer.id, orderId ?? null, kind, body, mediaUrl ?? null, now, buttons ? JSON.stringify(buttons) : null,invitation?JSON.stringify(invitation):null]);
    try {
      const sent = buttons ? await this.provider.sendButtons(phone, body, buttons) : mediaUrl
        ? await this.provider.sendImage(phone, mediaUrl, body)
        : await this.provider.sendText(phone, body);
      await this.db.query(`UPDATE message_outbox SET status = 'sent', attempts = 1, provider_message_id = $1, sent_at = $2 WHERE id = $3`, [sent.messageId, new Date().toISOString(), id]);
      return sent;
    } catch (error) {
      await this.db.query(`UPDATE message_outbox SET status = 'failed', attempts = 1, last_error = $1 WHERE id = $2`, [error instanceof Error ? error.message : String(error), id]);
      throw error;
    }
  }
}
