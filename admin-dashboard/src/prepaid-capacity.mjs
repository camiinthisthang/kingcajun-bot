import {bookingCapacitySql,deliveryCapacitySql} from './booking-capacity.mjs';
import {requireValue} from './kitchen-domain.mjs';

// Owner-approved additional delivery allowance, shared by every window on a day.
export const PREPAID_DELIVERIES_PER_DAY = 7;
export const activeReservationSql = (alias,now='$1') => `(${alias}.status IN ('confirmed','fulfilled','payment_review') OR (${alias}.status='awaiting_payment' AND ${alias}.payment_expires_at>${now}))`;
export const prepaidUsedSql = (date,now='$1') => `(SELECT COUNT(*)::int FROM orders po JOIN delivery_windows pw ON pw.id=po.delivery_window_id WHERE (pw.starts_at AT TIME ZONE 'America/Bogota')::date=${date} AND po.prepaid_delivery=TRUE AND ${deliveryCapacitySql('po')} AND ${activeReservationSql('po',now)})`;
export async function migratePrepaidCapacity(db) {
  await db.exec(`ALTER TABLE delivery_windows ADD COLUMN IF NOT EXISTS total_order_capacity INTEGER CHECK(total_order_capacity>=0);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepaid_delivery BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS delivery_zone_allowances (
      delivery_window_id UUID NOT NULL REFERENCES delivery_windows(id),
      zone TEXT NOT NULL CHECK (zone IN ('itagui')),
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 100),
      PRIMARY KEY(delivery_window_id,zone)
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS full_payment_required BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE delivery_date_limits ADD COLUMN IF NOT EXISTS full_payment_required BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS delivery_waitlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), customer_id UUID NOT NULL REFERENCES customers(id),
      delivery_window_id UUID NOT NULL REFERENCES delivery_windows(id),
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','contacted','withdrawn','ordered')),
      draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      consent_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'customer', UNIQUE(customer_id,delivery_window_id)
    );
    CREATE INDEX IF NOT EXISTS delivery_waitlist_window_status ON delivery_waitlist(delivery_window_id,status);`);
}
export async function joinDeliveryWaitlist(db,{phone,windowId,draft={}},now=new Date()) {
 return db.transaction(async tx=>{
  const w=(await tx.query(`SELECT id FROM delivery_windows WHERE id=$1 AND status='open' AND starts_at>$2 AND order_cutoff_at>$2 AND (order_opens_at IS NULL OR order_opens_at<=$2)`,[windowId,now.toISOString()])).rows[0];
  requireValue(w,'La franja ya cerró; elige otra fecha.',409);
  const c=(await tx.query('SELECT id FROM customers WHERE phone_e164=$1',[phone])).rows[0];
  requireValue(c,'Cliente no encontrado.',404);
  return (await tx.query(`INSERT INTO delivery_waitlist(customer_id,delivery_window_id,draft_json,consent_at,created_at,updated_at)
    VALUES($1,$2,$3::jsonb,$4,$4,$4) ON CONFLICT(customer_id,delivery_window_id) DO UPDATE SET
    status='waiting',draft_json=excluded.draft_json,consent_at=excluded.consent_at,updated_at=excluded.updated_at,updated_by='customer' RETURNING id`,[c.id,windowId,JSON.stringify(draft),now.toISOString()])).rows[0];
 });
}
export async function withdrawDeliveryWaitlist(db,phone,now=new Date()) {
 return db.query(`UPDATE delivery_waitlist l SET status='withdrawn',updated_at=$2,updated_by='customer' FROM customers c WHERE c.id=l.customer_id AND c.phone_e164=$1 AND l.status IN ('waiting','contacted')`,[phone,now.toISOString()]);
}
export async function readDeliveryWaitlist(db,now=new Date()) {
 const date="(w.starts_at AT TIME ZONE 'America/Bogota')::date";
 const zone="l.draft_json->>'deliveryZone'";
 const used=(scope,capacityZone='NULL')=>`(SELECT COUNT(*)::int FROM orders o JOIN delivery_windows dw ON dw.id=o.delivery_window_id WHERE ${scope} AND ${deliveryCapacitySql('o',capacityZone)} AND ${activeReservationSql('o')})`;
 return (await db.query(`SELECT l.id,l.status,l.consent_at,c.display_name,c.phone_e164,w.starts_at,w.ends_at,${date}::text AS delivery_date,
   ${zone} AS delivery_zone,
   w.status='open' AND w.order_cutoff_at>$1 AND (w.order_opens_at IS NULL OR w.order_opens_at<=$1)
   AND CASE WHEN ${zone} IS NOT NULL THEN
     w.starts_at-interval '12 hours'>$1 AND COALESCE((SELECT capacity FROM delivery_zone_allowances WHERE delivery_window_id=w.id AND zone=${zone}),0)-${used('o.delivery_window_id=w.id',zone)}>0
   ELSE LEAST(${bookingCapacitySql('w.capacity')}-${used('o.delivery_window_id=w.id')},
   ${bookingCapacitySql(`COALESCE((SELECT capacity FROM delivery_date_limits WHERE delivery_date=${date}),(SELECT SUM(capacity) FROM delivery_windows dw WHERE (dw.starts_at AT TIME ZONE 'America/Bogota')::date=${date}))`)}-${used(`(dw.starts_at AT TIME ZONE 'America/Bogota')::date=${date}`)})>0 END AS space_available
   FROM delivery_waitlist l JOIN customers c ON c.id=l.customer_id JOIN delivery_windows w ON w.id=l.delivery_window_id
   WHERE l.status IN ('waiting','contacted') AND w.ends_at>$1 ORDER BY l.consent_at`,[now.toISOString()])).rows;
}
export async function updateDeliveryWaitlist(db,id,status,actor) {
 requireValue(['contacted','withdrawn','waiting'].includes(status),'Estado de lista inválido.');
 const result=await db.query('UPDATE delivery_waitlist SET status=$2,updated_by=$3,updated_at=now() WHERE id=$1 RETURNING id',[id,status,actor]);
 requireValue(result.rowCount,'Registro no encontrado.',404);return {id,status};
}
