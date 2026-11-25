import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Db, DbClient } from '../db/index.js';
import type { Config } from '../config.js';
import type { PaymentConfirmation } from '../types.js';
import { windowLabel } from '../lib/format.js';

export class PaymentService {
  constructor(private readonly db: Db, private readonly cfg: Config) {}

  async confirm(event: PaymentConfirmation) {
    const now = DateTime.now().toUTC();
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query(`
        INSERT INTO webhook_events (id, provider, provider_event_id, payload_json, received_at)
        VALUES ($1, 'bancolombia', $2, $3::jsonb, $4)
        ON CONFLICT(provider, provider_event_id) DO NOTHING
        RETURNING id
      `, [randomUUID(), event.eventId, JSON.stringify(event.raw), now.toISO()]);
      if (!claimed.rowCount) return { duplicate: true as const };

      const row = (await tx.query<any>(`
        SELECT p.id::text AS payment_id, p.provider, p.amount_cop, p.status AS payment_status,
               o.id::text AS order_id, o.public_id, o.status AS order_status,
               o.payment_expires_at, o.fulfillment_type, o.delivery_address, o.delivery_coverage, o.reminder_confirmation_required,
               c.id::text AS customer_id, c.phone_e164, w.starts_at, w.ends_at
        FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
        JOIN delivery_windows w ON w.id = o.delivery_window_id
        WHERE p.reference = $1 FOR UPDATE OF p, o
      `, [event.reference])).rows[0];
      if (!row) throw new Error('Referencia de pago desconocida');
      if (row.provider === 'cash_on_delivery') throw new Error('Este pedido se paga contra entrega; no admite confirmaciones bancarias anticipadas');
      if (row.payment_status === 'confirmed') {
        await this.markWebhook(tx, event.eventId, now.toISO()!);
        return { duplicate: true as const, order: row };
      }
      const payload = JSON.stringify(event.raw);
      // A delayed bank event must never revive a cancelled order.
      if (row.order_status === 'cancelled') {
        if (event.status === 'confirmed') {
          await tx.query(`UPDATE payments SET status=$1, provider_payment_id=$2, raw_payload_json=$3::jsonb, confirmed_at=$4, updated_at=$4 WHERE id=$5`,
            [event.amountCop === row.amount_cop ? 'confirmed' : 'amount_mismatch', event.providerPaymentId, payload, now.toISO(), row.payment_id]);
          await tx.query(`UPDATE orders SET refund_status='pending', updated_at=$1 WHERE id=$2`, [now.toISO(), row.order_id]);
        }
        await this.markWebhook(tx, event.eventId, now.toISO()!);
        return { duplicate: false as const, cancelled: true as const, order: row };
      }

      if (event.status === 'failed') {
        await tx.query(`UPDATE payments SET status = 'failed', provider_payment_id = $1, raw_payload_json = $2::jsonb, updated_at = $3 WHERE id = $4`, [event.providerPaymentId, payload, now.toISO(), row.payment_id]);
        await this.markWebhook(tx, event.eventId, now.toISO()!);
        return { duplicate: false as const, failed: true as const, order: row };
      }
      if (event.amountCop !== row.amount_cop) {
        await tx.query(`UPDATE payments SET status = 'amount_mismatch', provider_payment_id = $1, raw_payload_json = $2::jsonb, updated_at = $3 WHERE id = $4`, [event.providerPaymentId, payload, now.toISO(), row.payment_id]);
        await tx.query(`UPDATE orders SET status = 'payment_review', updated_at = $1 WHERE id = $2`, [now.toISO(), row.order_id]);
        await this.markWebhook(tx, event.eventId, now.toISO()!);
        return { duplicate: false as const, mismatch: true as const, order: row };
      }
      if (row.payment_expires_at < now.toISO()! || row.order_status !== 'awaiting_payment') {
        await tx.query(`UPDATE payments SET status = 'confirmed', provider_payment_id = $1, raw_payload_json = $2::jsonb, confirmed_at = $3, updated_at = $3 WHERE id = $4`, [event.providerPaymentId, payload, now.toISO(), row.payment_id]);
        await tx.query(`UPDATE orders SET status = 'payment_review', updated_at = $1 WHERE id = $2`, [now.toISO(), row.order_id]);
        await this.markWebhook(tx, event.eventId, now.toISO()!);
        return { duplicate: false as const, late: true as const, order: row };
      }
      await tx.query(`UPDATE payments SET status = 'confirmed', provider_payment_id = $1, raw_payload_json = $2::jsonb, confirmed_at = $3, updated_at = $3 WHERE id = $4`, [event.providerPaymentId, payload, now.toISO(), row.payment_id]);
      await tx.query(`UPDATE orders SET status = 'confirmed', updated_at = $1 WHERE id = $2`, [now.toISO(), row.order_id]);

      const start = DateTime.fromISO(row.starts_at);
      for (const reminder of [{ hours: 24, kind: 'reminder_24h' }, { hours: 6, kind: 'reminder_6h' }]) {
        const due = start.minus({ hours: reminder.hours });
        if (due > now) {
          const body = `⏰ Recordatorio de ${this.cfg.BUSINESS_NAME}: tu pedido ${row.public_id} es ${windowLabel(row.starts_at, row.ends_at, this.cfg.BUSINESS_TIMEZONE)}. Entrega en ${row.delivery_address}.`;
          await tx.query(`
            INSERT INTO message_outbox (id, customer_id, order_id, kind, body, due_at, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
          `, [randomUUID(), row.customer_id, row.order_id, reminder.kind, body, due.toUTC().toISO(), now.toISO()]);
        }
      }
      await this.markWebhook(tx, event.eventId, now.toISO()!);
      return { duplicate: false as const, confirmed: true as const, order: row };
    });
  }

  private async markWebhook(tx: DbClient, eventId: string, at: string) {
    await tx.query(`UPDATE webhook_events SET processed_at = $1 WHERE provider = 'bancolombia' AND provider_event_id = $2`, [at, eventId]);
  }
}
