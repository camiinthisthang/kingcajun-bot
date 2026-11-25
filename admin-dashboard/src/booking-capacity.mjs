// Delivery-route capacity, not a limit on the number of meals to prepare.
export const BOOKING_CAPACITY_PERCENT = 120;
/** @param {number} base */
export const bookingCapacity = base => Math.floor(base * BOOKING_CAPACITY_PERCENT / 100);
/** SQL expression supplied by application code, never customer input. @param {string} base */
export const bookingCapacitySql = base => `FLOOR((${base})::numeric * ${BOOKING_CAPACITY_PERCENT} / 100)::int`;

/** Staff-approved method takes precedence over the original customer preference. */
export const usesDeliveryCapacity = (order = {}) => {
  const coverage = order.delivery_coverage ?? order.deliveryCoverage ?? {};
  return !['pickup', 'own_courier'].includes(coverage.method ?? coverage.preference ?? order.fulfillment_type ?? order.fulfillmentType ?? 'delivery');
};
/** Trusted SQL alias only. Keep identical to usesDeliveryCapacity for old and new orders. */
export const deliveryCapacitySql = (alias, zone = 'NULL') => `(COALESCE(${alias}.delivery_coverage->>'method', ${alias}.delivery_coverage->>'preference', ${alias}.fulfillment_type, 'delivery') NOT IN ('pickup','own_courier') AND (${alias}.delivery_coverage->>'capacityZone') IS NOT DISTINCT FROM ${zone})`;
/** Both collection methods avoid King Cajun's delivery route. */
export const bookingType = preference => ['pickup', 'own_courier'].includes(preference) ? 'pickup' : 'delivery';
export const windowAvailable = window => window.pickup_available === true || window.remaining > 0;

// A pickup converted to delivery must acquire capacity under the same day/window
// locks as checkout. Caller already holds the kitchen-run lock, if applicable.
/** @param {any} tx @param {string} windowId @param {string|null} zone */
export async function lockDeliveryCapacity(tx, windowId, zone = null) {
  const date = (await tx.query("SELECT (starts_at AT TIME ZONE 'America/Bogota')::date::text AS date FROM delivery_windows WHERE id=$1", [windowId])).rows[0]?.date;
  if (!date) throw new Error('La franja ya no existe');
  await tx.query("INSERT INTO delivery_date_limits(delivery_date,capacity) SELECT $1::date,SUM(capacity)::int FROM delivery_windows WHERE (starts_at AT TIME ZONE 'America/Bogota')::date=$1::date ON CONFLICT DO NOTHING", [date]);
  const day = (await tx.query('SELECT capacity,full_payment_required FROM delivery_date_limits WHERE delivery_date=$1 FOR UPDATE', [date])).rows[0];
  const window = (await tx.query('SELECT capacity FROM delivery_windows WHERE id=$1 FOR UPDATE', [windowId])).rows[0];
  if(zone){
    const allowance=(await tx.query('SELECT capacity FROM delivery_zone_allowances WHERE delivery_window_id=$1 AND zone=$2 FOR UPDATE',[windowId,zone])).rows[0];
    if(!allowance)throw new Error('No hay ruta especial disponible para esa zona en esa fecha. Elige una franja disponible.');
    return {date,day:allowance.capacity,window:allowance.capacity,fullPaymentRequired:true,zone};
  }
  return {date, day:bookingCapacity(day.capacity), window:bookingCapacity(window.capacity),fullPaymentRequired:day.full_payment_required===true};
}
/** @param {any} tx @param {string} windowId @param {string} date @param {string} now @param {string|null} excludeOrderId @param {string|null} zone */
export async function deliveryCapacityUsed(tx, windowId, date, now, excludeOrderId = null, zone = null) {
  return (await tx.query(`SELECT COUNT(*)::int AS daily,
    COUNT(*) FILTER (WHERE o.delivery_window_id=$1)::int AS window
    FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id
    WHERE (w.starts_at AT TIME ZONE 'America/Bogota')::date=$2::date
      AND ($4::uuid IS NULL OR o.id<>$4::uuid) AND ${deliveryCapacitySql('o','$5::text')}
      AND ($5::text IS NULL OR o.delivery_window_id=$1)
      AND (o.status IN ('confirmed','fulfilled','payment_review') OR (o.status='awaiting_payment' AND o.payment_expires_at>$3))`, [windowId,date,now,excludeOrderId,zone])).rows[0];
}
