import type {DbClient} from '../db/index.js';

export const barrioReviewNotice='Continuamos con tu pedido; el equipo revisará la cobertura con los datos que ya nos compartiste.';
const barrioRequest=()=>/(?:¿\s*)?(?:cu[aá]l es (?:el nombre (?:del|de tu) |tu |el )barrio|en qu[eé] barrio[^?\n.]*|(?:dime|dinos|ind[ií]came|conf[ií]rmame|env[ií]ame) (?:el nombre (?:del|de tu) |tu |el )barrio)[^?\n.]*[?.]?/gi;
export const asksBarrioName=(body:string)=>barrioRequest().test(body);

// Read actual sent messages, including manual replies and conversations from
// before this policy. A reset, changed address or SIGUE cannot restart the loop.
export async function barrioAlreadyAsked(db:DbClient,phone:string){
 const rows=(await db.query<{body:string}>(`SELECT m.body FROM message_outbox m JOIN customers c ON c.id=m.customer_id
   WHERE c.phone_e164=$1 AND m.status='sent' AND m.body ILIKE '%barrio%'
   UNION ALL SELECT body FROM whatsapp_staff_events WHERE customer_phone=$1 AND body ILIKE '%barrio%'`,[phone])).rows;
 return rows.some(row=>asksBarrioName(row.body));
}

export async function limitBarrioRequest(db:DbClient,phone:string,body:string){
 return asksBarrioName(body)&&await barrioAlreadyAsked(db,phone)
   ? body.replace(barrioRequest(),barrioReviewNotice) : body;
}
