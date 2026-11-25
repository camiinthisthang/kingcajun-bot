import type {Db} from '../db/index.js';
import type {InboundMessage} from '../types.js';
import {normalizeText} from '../lib/format.js';
import {locationFromAddress,coverageSnapshot} from './delivery-coverage.js';
import {resolveLocationInput} from '../../admin-dashboard/src/dispatch-location.mjs';
import {pointMapsLink} from '../../admin-dashboard/public/location-utils.js';

// Only this customer's sent 24-hour reminders can receive location corrections.
// An acknowledged correction prevents a cancellation for silence, but stays
// visibly unresolved until the customer confirms the proposed point.
export async function receiveLocationCorrection(db:Db,message:InboundMessage,now=new Date(),allowUnpromptedPoint=true):Promise<string|null>{
  const text=normalizeText(message.text);
  if(/^\s*confirmo\s+kc-[a-z0-9]+\s+6h\b/i.test(message.text))return null;
  const negative=/\b(?:direccion incorrecta|ubicacion incorrecta|punto incorrecto|pin incorrecto|(?:el )?mapa esta mal|no (?:es|esta) (?:ahi|alli|bien|correct[oa])|esa no es|no es (?:mi|la) direccion|cambiar (?:la )?direccion)\b/.test(text);
  const link=message.text.match(/https:\/\/(?:maps\.app\.goo\.gl|goo\.gl|(?:www\.)?google\.com(?:\.co)?|maps\.google\.com(?:\.co)?)\/[^\s<>]+/i)?.[0];
  const completeAddress=/\b(?:carrera|cra|cr|calle|cll|cl|transversal|tv|diagonal|avenida)\.?\s*\d/i.test(message.text);
  const coordinates=/^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$/.test(message.text);
  const rows=(await db.query<any>(`SELECT m.*,o.public_id,o.delivery_address,o.delivery_coverage FROM message_outbox m
    JOIN orders o ON o.id=m.order_id JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
    WHERE c.phone_e164=$1 AND o.status='confirmed' AND w.starts_at>$2 AND m.kind='reminder_24h' AND m.status='sent' AND m.location_check_json IS NOT NULL
    AND ($3::text IS NULL OR o.public_id=$3) AND ($4::text IS NULL OR m.provider_message_id=$4)
    ORDER BY m.due_at DESC`,[message.phone,now.toISOString(),message.text.match(/KC-[A-Z0-9]+/i)?.[0].toUpperCase()??null,message.replyToMessageId??null])).rows;
  const active=rows.filter(r=>r.location_check_json.status!=='manual_review'&&(negative||['needs_address','needs_pin','needs_barrio'].includes(r.location_check_json.status)||((link||coordinates||completeAddress&&r.location_check_json.proposal)&&(allowUnpromptedPoint||message.replyToMessageId||/KC-[A-Z0-9]+/i.test(message.text))&&r.location_check_json.status==='pending')));
  if(!active.length)return null;
  if(active.length!==1)return 'Tienes varios pedidos. Indica la referencia KC-… de la dirección que quieres corregir.';
  const row=active[0],check=structuredClone(row.location_check_json);
  const reservedCoverage=(value:string)=>{
    const base=coverageSnapshot(locationFromAddress(value));
    if(row.delivery_coverage?.capacityZone==='itagui'&&base.destinationZone==='itagui')return {...base,status:'inside' as const,needsReview:false,capacityZone:'itagui'};
    return base;
  };
  if(negative){check.status='needs_address';delete check.proposal;}
  let proposal=check.proposal??{address:row.delivery_address,coverage:row.delivery_coverage??{}};
  const address=message.text.replace(/https:\/\/\S+/g,'').replace(/\bKC-[A-Z0-9]+\b/ig,'').replace(/(?:direcci[oó]n|ubicaci[oó]n|punto|pin) incorrect[oa][,:.]?/ig,'').trim();
  if(/\b(?:carrera|cra|cr|calle|cll|cl|transversal|tv|diagonal|avenida)\.?\s*\d/i.test(address)&&address.length>=8){
    const coverage=reservedCoverage(address);
    proposal={address,coverage};
    check.status=coverage.status==='inside'?'needs_pin':'needs_barrio';
  }else if(check.status==='needs_barrio'&&!negative&&!link&&!coordinates&&address.length>2&&!/^confirm|^gracias|^hola/.test(text)){
    const combined=proposal.address+', '+address,coverage=reservedCoverage(combined);
    if(coverage.status==='inside'){proposal={...proposal,address:combined,coverage};check.status=proposal.point?'pending':'needs_pin';}
  }
  let invalidPoint:string|null=null;
  if(link||coordinates){
    try{proposal.point=await resolveLocationInput({value:link??message.text});}
    catch{
      check.status='manual_review';
      check.submittedLocation=link??message.text;
      check.submittedAt=now.toISOString();
      delete proposal.point;
      invalidPoint='Gracias, recibimos tu ubicación. El equipo revisará el enlace; no necesitas enviarlo de nuevo. Tu pedido sigue activo.';
    }
  }
  if(check.status!=='manual_review'&&proposal.point&&proposal.coverage.status==='inside')check.status='pending';
  if(!negative||proposal.point||proposal.address!==row.delivery_address)check.proposal=proposal;
  if(check.status==='pending'){check.url=pointMapsLink(proposal.point);check.exactPoint=true;}
  const result=await db.transaction(async tx=>{
    const fresh=(await tx.query<any>('SELECT status,delivery_address,delivery_coverage FROM orders WHERE id=$1 FOR UPDATE',[row.order_id])).rows[0];
    const reminder=(await tx.query<any>('SELECT location_check_json,confirmation_received_at,confirmation_deadline_at FROM message_outbox WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
    if(fresh?.status!=='confirmed')return 'El pedido ya no está activo. Contacta al equipo para revisarlo.';
    if(fresh.delivery_address!==row.delivery_address||(fresh.delivery_coverage?.dispatchLocation?.revision??null)!==(row.delivery_coverage?.dispatchLocation?.revision??null)||JSON.stringify(reminder.location_check_json)!==JSON.stringify(row.location_check_json))return 'La ubicación acaba de cambiar. Envía de nuevo tu corrección para revisar el punto más reciente.';
    await tx.query('UPDATE message_outbox SET location_check_json=$2::jsonb,confirmation_received_at=COALESCE(confirmation_received_at,$3) WHERE id=$1',[row.id,JSON.stringify(check),now.toISOString()]);
    await tx.query('UPDATE orders SET delivery_coverage=$2::jsonb WHERE id=$1',[row.order_id,JSON.stringify({...fresh.delivery_coverage,locationConfirmation:{status:'needs_correction',requestedAt:now.toISOString()}})]);
    if(check.status==='manual_review'){
      await tx.query(`INSERT INTO whatsapp_chat_controls(customer_phone,paused_until,updated_at,updated_by,manual_paused_at) VALUES($1,$2,$2,$3,$2) ON CONFLICT(customer_phone) DO UPDATE SET manual_paused_at=COALESCE(whatsapp_chat_controls.manual_paused_at,excluded.manual_paused_at),updated_at=excluded.updated_at,updated_by=excluded.updated_by`,[message.phone,now.toISOString(),'location-review:'+message.eventId]);
    }
    return null;
  });
  if(result)return result;
  if(invalidPoint)return invalidPoint;
  if(check.status==='pending')return `Revisa el punto para ${row.public_id}: ${check.url}\nDirección: ${proposal.address}\nSi está correcto, responde CONFIRMO ${row.public_id} 24H. Aún no hemos reemplazado la dirección guardada.`;
  if(check.status==='needs_barrio')return '¿Cuál es el nombre del barrio? Necesitamos revisar la cobertura de la dirección corregida. Tu pedido sigue activo.';
  if(check.status==='needs_pin')return `Gracias. Tengo esta dirección para revisar: ${proposal.address}. Envíame el enlace compartido de Google Maps del punto exacto de entrada o sus coordenadas (latitud, longitud).`;
  return `Gracias por avisar. Tu pedido ${row.public_id} sigue activo. Envíame la dirección completa con barrio, edificio y apartamento, y el enlace de Google Maps del punto correcto.`;
}
