import {orderConfirmationNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';
import type { Config } from '../config.js';
import { cop, normalizePhone, windowLabel } from '../lib/format.js';
import type { PaymentConfirmation } from '../types.js';
import type { MessagingService } from './messaging.js';
import { canUseBot } from '../lib/bot-access.js';

type PaymentResult =
  | { duplicate: true }
  | { duplicate: false; confirmed?: true; failed?: true; mismatch?: true; late?: true; order: any };

export class PaymentNotificationService {
  constructor(private readonly cfg: Config, private readonly messaging: MessagingService) {}

  async handle(result: PaymentResult, event: PaymentConfirmation) {
    if (this.cfg.BOT_MODE === 'standby' || result.duplicate || !('order' in result)) return { customerSent: false, staffSent: 0 };

    const order = result.order;
    const status = result.confirmed
      ? 'CONFIRMADO'
      : result.mismatch
        ? 'MONTO DIFERENTE'
        : result.late
          ? 'PAGO TARDÍO / REVISAR'
          : 'FALLIDO';
    const staffBody = result.confirmed
      ? `💰 *Pago confirmado*

• Pedido: ${order.public_id}
• Valor: ${cop(event.amountCop)}
• Referencia: ${event.reference}
• Cliente: ${order.phone_e164}
• Transacción bancaria: ${event.providerPaymentId}`
      : `⚠️ *Pago requiere atención*

• Estado: ${status}
• Pedido: ${order.public_id}
• Esperado: ${cop(order.amount_cop)}
• Reportado: ${cop(event.amountCop)}
• Referencia: ${event.reference}
• Cliente: ${order.phone_e164}`;

    const work: Array<Promise<unknown>> = [];
    const customerAllowed = canUseBot(this.cfg, order.phone_e164);
    if (result.confirmed && customerAllowed) {
      work.push(this.messaging.sendNow(
        order.phone_e164,
        `${order.delivery_coverage?.needsReview?'✅ *Pago recibido · entrega pendiente de coordinación*':'✅ *Pago recibido y pedido confirmado*'}

• Pedido: ${order.public_id}
• Franja: ${windowLabel(order.starts_at, order.ends_at, this.cfg.BUSINESS_TIMEZONE)}
• Entrega: ${order.delivery_address}

${order.delivery_coverage?.needsReview?'El equipo debe coordinar la cobertura, modalidad y tarifa. La entrega aún no está confirmada.':orderConfirmationNotice(order)}`,
        'order_confirmation',
        order.order_id,
      ));
    }

    const staffNumbers = this.staffNumbers();
    for (const phone of staffNumbers) {
      work.push(this.messaging.sendPaymentAlertNow(
        phone,
        staffBody,
        [status, order.public_id, cop(event.amountCop), event.reference, order.phone_e164],
        order.order_id,
      ));
    }
    await Promise.allSettled(work);
    return { customerSent: Boolean(result.confirmed && customerAllowed), staffSent: staffNumbers.length };
  }

  private staffNumbers() {
    const configured = this.cfg.PAYMENT_ALERT_WHATSAPP_NUMBERS
      .split(',')
      .map((phone) => phone.trim())
      .filter(Boolean)
      .map(normalizePhone);
    const numbers = configured.length ? [...new Set(configured)] : this.cfg.WHATSAPP_PROVIDER === 'demo' ? ['+573009999999'] : [];
    return numbers.filter(phone => canUseBot(this.cfg, phone));
  }
}
