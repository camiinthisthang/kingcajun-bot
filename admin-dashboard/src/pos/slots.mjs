import {randomUUID} from 'node:crypto';
export async function readSlots(db){return (await db.query(`SELECT w.*,(w.capacity-count(o.id))::int AS remaining FROM delivery_windows w LEFT JOIN orders o ON o.delivery_window_id=w.id AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>now()) WHERE w.pos_enabled=TRUE AND w.ends_at>now()-interval '1 day' GROUP BY w.id ORDER BY w.starts_at LIMIT 100`)).rows;}
export async function saveSlot(db,body,actor){
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
 if(!actor?.roles.includes('Manager'))fail('Requiere permiso de administración.',403);
 if(!Number.isInteger(body.capacity)||body.capacity<1||body.capacity>1000)fail('El cupo debe ser un número entre 1 y 1000.');
 if(!['open','closed'].includes(body.status))fail('Estado de franja inválido.');
 if(body.id&&!/^[a-f0-9-]{36}$/i.test(body.id))fail('Franja inválida.');
 const id=body.id||randomUUID();
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR UPDATE');
  const old=(await tx.query('SELECT * FROM delivery_windows WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(body.id&&!old?.pos_enabled)fail('Esta franja no pertenece al nuevo servicio.',409);
  if(old){
   const used=Number((await tx.query("SELECT count(*) AS n FROM orders WHERE delivery_window_id=$1 AND (status IN ('confirmed','fulfilled','payment_review') OR status='awaiting_payment' AND payment_expires_at>now())",[id])).rows[0].n);
   if(body.capacity<used)fail(`Ya hay ${used} pedidos reservados. No puedes bajar el cupo por debajo de ese número.`,409);
   await tx.query('UPDATE delivery_windows SET capacity=$2,status=$3 WHERE id=$1',[id,body.capacity,body.status]);
  }else{
   const start=new Date(body.startsAt),end=new Date(body.endsAt),cutoff=new Date(body.cutoffAt);
   if(!Number.isFinite(+start)||!Number.isFinite(+end)||!Number.isFinite(+cutoff)||+start<=Date.now()||+end<=+start||+cutoff>=+start||+cutoff<=Date.now())fail('Revisa los horarios: cierre de pedidos antes del inicio, y fin después del inicio.');
   await tx.query("INSERT INTO delivery_windows(id,fulfillment_type,starts_at,ends_at,order_cutoff_at,capacity,status,created_at,pos_enabled) VALUES($1,'delivery',$2,$3,$4,$5,$6,now(),TRUE)",[id,start.toISOString(),end.toISOString(),cutoff.toISOString(),body.capacity,body.status]);
  }
  await tx.query('INSERT INTO pos_slot_changes(slot_id,actor_id,detail) VALUES($1,$2,$3::jsonb)',[id,actor.id,JSON.stringify({before:old||null,capacity:body.capacity,status:body.status})]);
  return {id,saved:true};
 });
}
