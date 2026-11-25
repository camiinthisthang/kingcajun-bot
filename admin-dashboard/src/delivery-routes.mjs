import {packingBatchHeading,packingCustomerName} from '../public/kitchen-search.js';
import {routeCuts,routeTrip} from '../public/route-trips.js';
import {deliveryInstructions} from '../public/delivery-instructions.js';
import {servicePeriods,matchesServicePeriod} from '../public/service-periods.js';
import {readFile} from 'node:fs/promises';
import {fulfillment,geocodeQuery} from '../public/operations-view.js';
import {savedDispatchLocation,pointMapsLink} from '../public/location-utils.js';
const money=n=>'$'+new Intl.NumberFormat('es-CO',{maximumFractionDigits:0}).format(n);
export function assembleRoutes(plan,orders) {
 const assigned=new Set(),issues=[];
 const active=o=>['confirmed','fulfilled'].includes(o.status)&&!o.delivery_coverage?.needsReview&&fulfillment(o)==='delivery';
 const groups=plan.groups.map(group=>{
  const stops=[];
  for(const ref of group.orders){
   const o=orders.find(o=>o.public_id===ref);
   if(!o||!active(o)){issues.push(`${ref}: fuera de esta ruta; revisa su fecha, estado o modalidad.`);continue;}
   if(assigned.has(ref))throw Error('Pedido duplicado en las rutas');assigned.add(ref);
   const phones=[...new Set([...(o.delivery_coverage?.contactPhones||[]),o.phone_e164].filter(p=>/^\+?\d{7,15}$/.test(p||'')))];
   const point=savedDispatchLocation(o),balance=Math.max(0,Number(o.total_cop)-Number(o.collected_cop));
   const name=/\p{L}/u.test(o.display_name||'')?o.display_name:'Nombre pendiente';
   const missing=[...(!phones.length?['teléfono pendiente']:[]),...(!point?['ubicación por verificar']:[]),...(name==='Nombre pendiente'?['nombre pendiente']:[])];
   const stop={reference:ref,name,phones,address:o.delivery_address||'Dirección pendiente',point,locationQuery:point?null:geocodeQuery(o),mapUrl:point?pointMapsLink(point):null,balance,variableWeight:o.variable_weight,notes:[...new Set([o.delivery_coverage?.deliveryPromise?.note,plan.stopNotes?.[ref]].filter(Boolean))],instructions:deliveryInstructions(o,plan.stopNotes?.[ref]),missing};
   stops.push(stop);
  }
  const lines=[`KING CAJUN · ${plan.date?new Intl.DateTimeFormat('es-CO',{weekday:'long',day:'numeric',month:'long',timeZone:'America/Bogota'}).format(new Date(plan.date+'T12:00:00-05:00')):'Fecha por confirmar'} · ${group.fulfillment==='hq_walk'?'Entrega a pie · HQ':'Conductor '+group.driver}`,group.area,plan.periodLabel?`Franja: ${plan.periodLabel}. Salida por coordinar desde ${plan.origin}.`:`Salida: 6:55 p. m. desde ${plan.origin}.`,group.note,''];
  stops.forEach((s,i)=>{lines.push(`${i+1}. ${s.name} · ${s.reference}`,`Tel: ${s.phones.join(' / ')||'PENDIENTE'}`,`Dirección: ${s.address}`,s.mapUrl?`Mapa: ${s.mapUrl}`:'MAPA PENDIENTE: confirmar con el equipo antes de salir.',s.balance?`COBRAR: ${money(s.balance)} COP`:'PAGADO COMPLETO · NO COBRAR',...(s.variableWeight?['Saldo sujeto al peso final del cangrejo: confirmar con cocina antes de cobrar.']:[]),...s.notes,'');});
  lines.push('Si hay una transferencia nueva o cambio de dirección, confirmar con King Cajun.');
  const splitLines=[...lines];
  const cuts=routeCuts(group),selectedCut=cuts[0];
  if(selectedCut){
   splitLines.splice(3,0,'OPCIÓN DOS VIAJES: llevar solo las primeras '+selectedCut+' paradas. Volver al punto de salida para recoger las restantes.',group.splitTiming || (plan.periodLabel?'Coordinar el regreso y la segunda salida dentro de esta franja.':'Objetivo: regresar entre 7:40 y 7:55 p. m.; segunda salida entre 8:00 y 8:10 p. m. Ajustar según tráfico y entregas.'));
   const next=stops.findIndex(s=>group.orders.indexOf(s.reference)>=selectedCut);
   if(next>=0){const at=splitLines.findIndex(l=>l?.startsWith(`${next+1}. `));splitLines.splice(at,0,'REGRESAR A '+plan.origin+' · RECOGER SEGUNDA TANDA','Mantener los siguientes pedidos calientes en cocina hasta la recogida.','');}
  }else splitLines.splice(3,0,`Un solo viaje: las ${stops.length} paradas se mantienen juntas.`);
  const trips=Array.from({length:cuts.length+1},(_,i)=>({trip:i+1,note:group.tripNotes?.[i]||'',stops:stops.filter(s=>routeTrip(group,group.orders.indexOf(s.reference))===i+1)})).filter(t=>t.stops.length);
  let selectedMessage=selectedCut?splitLines.join('\n'):lines.join('\n');
  if(Array.isArray(group.selectedSplitAfters)){
   const message=[`KING CAJUN · ${plan.date} · Conductor ${group.driver}${group.driverName?' · '+group.driverName:''}`,`Salida desde ${plan.origin}`,group.note,''];
   for(const t of trips){message.push(`VIAJE ${t.trip}`,t.note,...(t.trip>1?[`REGRESAR A COCINA (${plan.origin}) Y RECOGER ESTA TANDA RECIÉN EMPACADA`]:[]));t.stops.forEach((s,i)=>message.push(`${i+1}. ${s.name} · ${s.reference}`,`Tel: ${s.phones.join(' / ')||'PENDIENTE'}`,`Dirección: ${s.address}`,s.mapUrl?`Mapa: ${s.mapUrl}`:'MAPA PENDIENTE: revisar con el equipo antes de salir.',s.balance?`COBRAR: ${money(s.balance)} COP`:'PAGADO COMPLETO · NO COBRAR',...s.notes,''));}
   message.push('Confirmar con King Cajun cualquier pago o cambio de dirección.');selectedMessage=message.filter(x=>x!==undefined).join('\n');
  }
  return {...group,trips,stops,message:lines.join('\n'),splitMessage:splitLines.join('\n'),selectedMessage,balance:stops.reduce((n,s)=>n+s.balance,0)};
 });
 const unassigned=orders.filter(o=>active(o)&&!assigned.has(o.public_id)).map(o=>({reference:o.public_id,name:o.display_name,address:o.delivery_address,phones:[...new Set([...(o.delivery_coverage?.contactPhones||[]),o.phone_e164].filter(Boolean))],point:savedDispatchLocation(o),startsAt:o.starts_at,endsAt:o.ends_at,instructions:deliveryInstructions(o,plan.stopNotes?.[o.public_id])}));
 return {...plan,groups,issues,unassigned,updatedAt:new Date().toISOString()};
}
export async function readDeliveryRoutes(db,date='2026-10-17',periodId='') {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Fecha inválida');
 let plan;try{plan=JSON.parse(await readFile(new URL(`./routes/${date}.json`,import.meta.url),'utf8'));}catch(e){if(e.code==='ENOENT')plan={date,origin:'El Poblado',groups:[],issues:[]};else throw e;}
 const orders=(await db.query(`SELECT o.public_id,o.delivery_window_id,w.starts_at,w.ends_at,o.status,o.fulfillment_type,o.delivery_address,o.delivery_coverage,o.total_cop,o.notes,c.display_name,c.phone_e164,
 COALESCE((SELECT sum(p.amount_cop) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed'),0)::int AS collected_cop,
 EXISTS(SELECT 1 FROM order_line_items li WHERE li.order_id=o.id AND li.customization_json->>'finalWeightPending'='true') AS variable_weight
 FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
 WHERE (w.starts_at AT TIME ZONE 'America/Bogota')::date=$1::date ORDER BY o.public_id`,[date])).rows;
 const doc=(await db.query('SELECT document FROM kitchen_runs WHERE delivery_date=$1',[date])).rows[0]?.document;
 const saved=doc?.dispatchOverride;
 if(saved)plan={...plan,...saved,groups:saved.groups,riderCount:saved.riderCount};
 const windows=(await db.query("SELECT * FROM delivery_windows WHERE (starts_at AT TIME ZONE 'America/Bogota')::date=$1 ORDER BY starts_at",[date])).rows.filter(w=>w.status!=='closed'||orders.some(o=>o.delivery_window_id===w.id&&!['cancelled','expired'].includes(o.status)));
 const periods=servicePeriods(windows),period=periods.find(p=>p.id===periodId);
 if(periodId&&!period)throw Error('Franja inválida para esta fecha.');
 const visible=orders.filter(o=>matchesServicePeriod(o,period));
 if(!period&&periods.length>1)plan={...plan,periodLabel:'Varias franjas; coordinar cada salida por horario'};
 if(period){const refs=new Set(visible.map(o=>o.public_id));plan={...plan,periodLabel:period.label,groups:plan.groups.map(g=>{const first=g.orders.slice(0,g.selectedSplitAfter||g.orders.length).filter(r=>refs.has(r)).length;const visibleTrips=Array.from({length:routeCuts(g).length+1},(_,i)=>({orders:g.orders.filter((r,j)=>refs.has(r)&&routeTrip(g,j)===i+1),note:g.tripNotes?.[i]||''})).filter(t=>t.orders.length);let cumulative=0;const filteredCuts=visibleTrips.slice(0,-1).map(t=>cumulative+=t.orders.length);return {...g,orders:g.orders.filter(r=>refs.has(r)),mapNumbers:g.mapNumbers?.filter((_,i)=>refs.has(g.orders[i])),...(Array.isArray(g.selectedSplitAfters)?{selectedSplitAfters:filteredCuts,tripNotes:visibleTrips.map(t=>t.note)}:{}),selectedSplitAfter:g.selectedSplitAfter&&first>0?first:null,splitTiming:null};}).filter(g=>g.orders.length)};}
 const packingBatches=(doc?.packingBatches||[]).map(b=>({...b,label:packingBatchHeading(b,b.orders.map(ref=>visible.find(o=>o.public_id===ref&&['confirmed','fulfilled'].includes(o.status))).filter(Boolean).map(o=>({reference:o.public_id,customer:o.display_name,deliveryCoverage:o.delivery_coverage}))),orders:b.orders.map(ref=>visible.find(o=>o.public_id===ref&&['confirmed','fulfilled'].includes(o.status))).filter(Boolean).map(o=>({reference:o.public_id,name:packingCustomerName({reference:o.public_id,customer:o.display_name,deliveryCoverage:o.delivery_coverage}),method:fulfillment(o),address:o.delivery_address,phones:[...new Set([...(o.delivery_coverage?.contactPhones||[]),o.phone_e164].filter(p=>/^\+?\d{7,15}$/.test(p||'')))],balance:Math.max(0,Number(o.total_cop)-Number(o.collected_cop)),mapUrl:savedDispatchLocation(o)?pointMapsLink(savedDispatchLocation(o)):null}))})).filter(b=>b.orders.length);
 return {...assembleRoutes(plan,visible),packingBatches,periodId:period?.id||'',periods,settlements:period?{}:doc?.routeSettlements||{}};
}

export async function packingRoutePlan(date, override=null) {
 if(override)return override.groups;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return [];
 try{return JSON.parse(await readFile(new URL(`./routes/${date}.json`,import.meta.url),'utf8')).groups;}catch(e){if(e.code==='ENOENT')return [];throw e;}
}

export function regroupRoutes(groups,count) {
 if(!Number.isSafeInteger(count)||count<1||count>12)throw Error('Indica entre 1 y 12 domiciliarios.');
 const stops=groups.flatMap(g=>g.stops.map(s=>({...s,area:g.area})));if(!stops.length)return [];
 const n=Math.min(count,stops.length),distance=(a,b)=>a&&b?(a.lat-b.lat)**2+(a.lng-b.lng)**2:0;
 const seeds=[stops[0]];while(seeds.length<n){const remaining=stops.filter(s=>!seeds.includes(s));seeds.push(remaining.reduce((best,s)=>Math.min(...seeds.map(t=>distance(s.point,t.point)))>Math.min(...seeds.map(t=>distance(best.point,t.point)))?s:best));}
 let work=seeds.map((s,i)=>({stops:[s],areas:[s.area],limit:Math.floor(stops.length/n)+(i<stops.length%n?1:0)}));
 for(const stop of stops.filter(s=>!seeds.includes(s))){const available=work.filter(g=>g.stops.length<g.limit);const target=available.reduce((best,g)=>distance(stop.point,g.stops[0].point)<distance(stop.point,best.stops[0].point)?g:best);target.stops.push(stop);target.areas.push(stop.area);}
 // Preserve each original route's stop order, including its agreed delivery priorities.
 for(const g of work)g.stops.sort((a,b)=>stops.indexOf(a)-stops.indexOf(b));
 return work.map((g,i)=>({driver:i+1,area:[...new Set(g.areas)].join(' · '),orders:g.stops.map(s=>s.reference),splitAfter:g.stops.length>3?Math.ceil(g.stops.length/2):undefined,note:'Reparto ajustado a los domiciliarios disponibles. Conservar las instrucciones de cada entrega.'}));
}
export async function saveRiderCount(db,date,count) {
 const current=await readDeliveryRoutes(db,date);
 if(Object.keys(current.settlements||{}).length)throw Error('Ya hay liquidaciones guardadas para estas rutas. No se puede redistribuir sin revisar esas liquidaciones.');
 if(current.unassigned.length)throw Error('Hay domicilios sin ruta. Asígnalos antes de redistribuir.');
 const base=JSON.parse(await readFile(new URL(`./routes/${date}.json`,import.meta.url),'utf8'));
 const hq=current.groups.filter(g=>g.fulfillment==='hq_walk');
 const stops=current.groups.filter(g=>g.fulfillment!=='hq_walk').flatMap(g=>g.stops);
 const groups=regroupRoutes(base.groups.map(g=>({...g,stops:g.orders.map(ref=>stops.find(s=>s.reference===ref)).filter(Boolean)})),count);
 groups.push(...hq.map(({stops,trips,message,splitMessage,selectedMessage,balance,...g})=>g));
 const override={riderCount:count,groups,updatedAt:new Date().toISOString()};
 const result=await db.query("UPDATE kitchen_runs SET document=jsonb_set(document,'{dispatchOverride}',$2::jsonb),version=version+1,updated_at=now() WHERE delivery_date=$1 RETURNING id",[date,JSON.stringify(override)]);
 if(!result.rows.length)throw Error('Jornada no encontrada.');
 return readDeliveryRoutes(db,date);
}
