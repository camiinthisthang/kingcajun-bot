// An owner-opened extra window has its own exact order allowance. It does not
// reopen the day's existing windows or use the normal overbooking allowance.
export async function exactWindowCapacity(db,window,defaultDailyCap,now){
 const dedicated=window.total_order_capacity!=null;
 const capacity=dedicated?Number(window.total_order_capacity):Math.min(window.capacity,defaultDailyCap);
 const scope=dedicated?'o.delivery_window_id=$1::uuid':"(dw.starts_at AT TIME ZONE 'America/Bogota')::date=($1::timestamptz AT TIME ZONE 'America/Bogota')::date AND dw.total_order_capacity IS NULL";
 const used=(await db.query(`SELECT COUNT(*)::int AS n FROM orders o JOIN delivery_windows dw ON dw.id=o.delivery_window_id WHERE ${scope} AND (o.status IN ('confirmed','fulfilled','payment_review') OR (o.status='awaiting_payment' AND o.payment_expires_at>$2))`,[dedicated?window.id:window.starts_at,now])).rows[0].n;
 return {capacity,used,remaining:Math.max(0,capacity-used)};
}
