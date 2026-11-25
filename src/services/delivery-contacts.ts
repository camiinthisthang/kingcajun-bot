import type {DbClient} from '../db/index.js';
// Contact details are explicitly supplied by the customer, never inferred from a
// WhatsApp opaque business-scoped ID or copied from another customer's order.
export function contactNumbers(text:string):string[] {
  const candidates=text.match(/(?<![\dA-Za-z])(?:\+?57[ ()-]*)?(?:3(?:[ ()-]*\d){9}|60[1-8](?:[ ()-]*\d){7})(?!\d)|(?<![\dA-Za-z])\+[1-9](?:[ ()-]*\d){7,14}(?!\d)/g)??[];
  return [...new Set(candidates.flatMap(raw=>{
    const digits=raw.replace(/\D/g,'');
    if(/^3\d{9}$/.test(digits)||/^60[1-8]\d{7}$/.test(digits))return ['+57'+digits];
    if(/^57(?:3\d{9}|60[1-8]\d{7})$/.test(digits))return ['+'+digits];
    if(raw.trim().startsWith('+')&&/^[1-9]\d{7,14}$/.test(digits))return ['+'+digits];
    return [];
  }))];
}
export function onlyOneContact(text:string) {
  const value=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(!/\b(numero|telefono|celular|contacto|phone|number)\b/.test(value)&&/\b(combo|pedido|producto|cangrejo|langostino|salsa)\b/.test(value))return false;
  return /\b(?:solo|solamente|unicamente)\s+(?:(?:tengo|manejo|cuento con|uso)\s+)?(?:ese|este|uno|un (?:numero|telefono|celular))\b|\bno (?:tengo|cuento con)\s+(?:otro(?:s)?(?:\s+(?:numero|telefono|celular))?|mas (?:numeros|telefonos|celulares))\b|\b(?:mi|el) unico (?:numero|telefono|celular)\b|\bonly (?:have |got )?(?:one|this (?:number|phone))\b/i.test(value);
}
export function needsDeliveryContacts(context:{deliveryPreference?:string;fulfillmentType?:string;deliveryContactPhones?:string[];deliverySingleContactAccepted?:boolean}) {
  return new Set(context.deliveryContactPhones??[]).size<(context.deliverySingleContactAccepted?1:2);
}
export function deliveryContactPrompt(phones:string[],singleAccepted=false) {
  if(singleAccepted)return 'Está bien, podemos seguir con un solo contacto. Envíame tu único número para llamarte al llegar; incluye el código de país si es de otro país.';
  const exception=' Si solo tienes uno, dímelo y seguimos con ese.';
  return (phones.length===1?`Ya tengo ${phones[0]}. Envíame otro número diferente al que podamos llamar cuando llegue el domicilio.`:'Para coordinar la entrega, envíanos dos números de contacto diferentes: uno principal y otro de respaldo. Si alguno es de otro país, incluye el código (+…).')+exception;
}
export async function knownDeliveryContactDetails(db:DbClient,phone:string):Promise<{phones:string[];singleAccepted:boolean}> {
  const rows=(await db.query<any>(`SELECT o.delivery_coverage->'contactPhones' AS phones,o.delivery_coverage->'singleContactAccepted' AS single_accepted FROM orders o JOIN customers c ON c.id=o.customer_id
    WHERE c.phone_e164=$1 AND (jsonb_typeof(o.delivery_coverage->'contactPhones')='array' OR o.delivery_coverage->>'singleContactAccepted'='true') ORDER BY o.updated_at DESC LIMIT 20`,[phone])).rows;
  const sets=rows.map(r=>({phones:Array.isArray(r.phones)?[...new Set(r.phones.filter((p:unknown)=>typeof p==='string'&&/^\+[1-9]\d{7,14}$/.test(p)))].slice(0,2) as string[]:[],singleAccepted:r.single_accepted===true}));
  return sets.find(p=>p.phones.length===2||p.singleAccepted)??sets.find(p=>p.phones.length)??{phones:[],singleAccepted:false};
}
// Only process existing-order contact replies after a reminder actually requested
// them. Do not change addresses, totals, payment state, or reminder confirmation.
export async function receiveReminderContacts(db:DbClient,phone:string,text:string,now=new Date()):Promise<string|null> {
  const supplied=contactNumbers(text),onlyOne=onlyOneContact(text);if(!supplied.length&&!onlyOne)return null;
  const requested=(await db.query<any>(`SELECT o.id,o.public_id FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
    WHERE c.phone_e164=$1 AND o.status='confirmed' AND w.ends_at>$2
      AND EXISTS(SELECT 1 FROM message_outbox m WHERE m.order_id=o.id AND m.kind IN ('reminder_24h','reminder_6h','reminder_contact_request') AND m.status='sent' AND (m.body LIKE '%dos números de contacto diferentes%' OR m.body LIKE '%otro número diferente%' OR m.body LIKE '%único número%' OR (m.kind='reminder_24h' AND m.buttons_json IS NOT NULL)))
    ORDER BY w.starts_at`,[phone,now.toISOString()])).rows;
  if(!requested.length)return null;
  const known=await knownDeliveryContactDetails(db,phone);
  if(known.phones.length===2)return 'Ya tenemos los dos números de contacto para tu entrega. No necesitas enviarlos otra vez.';
  const phones=[...new Set([...known.phones,...supplied])].slice(0,2);
  const singleAccepted=phones.length<2&&(onlyOne||known.singleAccepted);
  // Populate this customer's active orders, so subsequent reminders and orders
  // reuse the same contacts. Historical completed/cancelled orders stay intact.
  await db.query(`UPDATE orders o SET delivery_coverage=COALESCE(o.delivery_coverage,'{}'::jsonb)||jsonb_build_object('contactPhones',$2::jsonb,'singleContactAccepted',$4::boolean),updated_at=$3
    FROM customers c,delivery_windows w WHERE c.id=o.customer_id AND w.id=o.delivery_window_id AND c.phone_e164=$1
    AND o.status IN ('confirmed','awaiting_payment','payment_review') AND w.ends_at>$3
    AND COALESCE(jsonb_array_length(o.delivery_coverage->'contactPhones'),0)<2`,[phone,JSON.stringify(phones),now.toISOString(),singleAccepted]);
  return phones.length===2?'✅ Guardamos los dos números de contacto para tu entrega. No volveremos a pedirlos.':phones.length===1&&singleAccepted?`✅ Seguimos con ${phones[0]} como tu único contacto. No necesitas otro número.`:deliveryContactPrompt(phones,singleAccepted);
}
