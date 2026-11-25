import {randomUUID} from 'node:crypto';
import {savedDispatchLocation,storedDispatchLocation,pointMapsLink} from '../public/location-utils.js';
import {displayAddress,geocodeQuery} from '../public/operations-view.js';
export async function migrateLocationConfirmation(db){
 await db.exec('ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS location_check_json JSONB;');
}
export function locationCheck(order){
 const point=savedDispatchLocation(order),address=order.delivery_address||'',query=geocodeQuery(order);
 const search=query?query.street+', '+query.city+', Colombia':displayAddress(order)+', Colombia';
 return {status:'pending',sourceAddress:address,sourceRevision:point?.revision??null,url:point?pointMapsLink(point):'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(search),exactPoint:!!point};
}
export function locationCheckPrompt(check,publicId){
 return check.exactPoint
  ? ` Mapa: ${check.url} . ¿Es el punto correcto? Responde CONFIRMO ${publicId} 24H para confirmar pedido y ubicación. Si está mal, responde DIRECCIÓN INCORRECTA con la dirección, barrio y enlace de Google Maps correcto.`
  : ` Ubica tu dirección aquí: ${check.url} . Responde CONFIRMO ${publicId} 24H si la dirección es correcta; envía también el enlace de Compartir del punto exacto de entrada.`;
}
// Called with the order and reminder locked by confirmReminder. A yes must refer
// to the location that was actually shown; staff edits invalidate an older link.
export async function confirmReminderLocation(tx,row,now){
 const check=row.location_check_json;if(row.kind!=='reminder_24h'||!check)return null;
 const order=(await tx.query('SELECT * FROM orders WHERE id=$1',[row.order_id])).rows[0];
 const current=storedDispatchLocation(order);
 if(check.sourceAddress!==order.delivery_address||(check.sourceRevision??null)!==(current?.revision??null)){
  const fresh=locationCheck(order);await tx.query('UPDATE message_outbox SET location_check_json=$2::jsonb,confirmation_received_at=COALESCE(confirmation_received_at,$3) WHERE id=$1',[row.id,JSON.stringify(fresh),now.toISOString()]);
  return {error:'La ubicación cambió desde el recordatorio. Revísala de nuevo.'+locationCheckPrompt(fresh,row.public_id)};
 }
 if(['needs_address','needs_pin','needs_barrio'].includes(check.status))return {error:`Ya recibimos tu respuesta. Para terminar de ubicar ${row.public_id}, envía ${check.status==='needs_pin'?'el enlace compartido de Google Maps del punto exacto':check.status==='needs_barrio'?'el nombre del barrio':'la dirección completa, barrio y enlace de Google Maps del punto correcto'}. Tu pedido sigue activo.`};
 if(check.status==='confirmed')return null;
 if(!check.exactPoint){
  await tx.query('UPDATE message_outbox SET location_check_json=$2::jsonb,confirmation_received_at=COALESCE(confirmation_received_at,$3) WHERE id=$1',[row.id,JSON.stringify({...check,status:'needs_pin'}),now.toISOString()]);
  await tx.query("UPDATE orders SET delivery_coverage=COALESCE(delivery_coverage,'{}'::jsonb)||jsonb_build_object('locationConfirmation',jsonb_build_object('status','needs_correction','requestedAt',$2::text)) WHERE id=$1",[order.id,now.toISOString()]);
  return {error:`✅ Confirmación recibida para ${row.public_id}. Para confirmar la ubicación, selecciona la entrada de tu edificio en Google Maps y envía el enlace de Compartir del punto exacto.`};
 }
 let coverage={...(order.delivery_coverage??{})};
 if(check.proposal){
  const p=check.proposal;
  if(!p.point||p.coverage?.status!=='inside')return {error:'Falta ubicar el punto y revisar el barrio antes de cambiar la dirección.'};
  if(coverage.capacityZone&&p.coverage?.destinationZone!==coverage.capacityZone)return {error:'Este cupo es exclusivo para Itagüí. El equipo debe revisar un cambio a otra zona antes de confirmar la dirección.'};
  const history=[...(coverage.locationHistory??[]),{address:order.delivery_address,point:coverage.dispatchLocation??null,changedAt:now.toISOString(),source:'customer_reminder'}].slice(-20);
  coverage={...coverage,status:p.coverage.status,label:p.coverage.label,policyVersion:p.coverage.policyVersion,needsReview:false,locationHistory:history,dispatchLocation:{...p.point,label:p.label??'',source:'customer_verified',sourceAddress:p.address,revision:randomUUID(),updatedAt:now.toISOString(),updatedBy:'customer · reminder_24h'}};
  await tx.query('UPDATE orders SET delivery_address=$2,delivery_coverage=$3::jsonb,updated_at=$4 WHERE id=$1',[order.id,p.address,JSON.stringify(coverage),now.toISOString()]);
 }
 coverage.locationConfirmation={status:'confirmed',at:now.toISOString(),sourceAddress:check.proposal?.address??order.delivery_address,pointRevision:coverage.dispatchLocation?.revision??null};
 await tx.query('UPDATE orders SET delivery_coverage=$2::jsonb WHERE id=$1',[order.id,JSON.stringify(coverage)]);
 const done={...check,status:'confirmed',confirmedAt:now.toISOString(),sourceAddress:coverage.locationConfirmation.sourceAddress,sourceRevision:coverage.dispatchLocation?.revision??null};
 await tx.query('UPDATE message_outbox SET location_check_json=$2::jsonb WHERE id=$1',[row.id,JSON.stringify(done)]);
 return {confirmed:true};
}
