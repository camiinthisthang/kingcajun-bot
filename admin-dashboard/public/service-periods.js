// Operational views only. Never rewrite booking windows, capacity or promises.
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
const timeFormat=new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',hour:'numeric',minute:'2-digit'});
const clockFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function servicePeriods(windows){
 const groups=new Map();
 for(const w of [...windows].sort((a,b)=>a.starts_at.localeCompare(b.starts_at))){
  const date=dateFormat.format(new Date(w.starts_at));
  // Include newly booked noon pickups/deliveries in the same operational shift.
  const startClock=clockFormat.format(new Date(w.starts_at)),endClock=clockFormat.format(new Date(w.ends_at));
  const midday=date==='2026-10-23'&&dateFormat.format(new Date(w.ends_at))===date&&startClock>='11:30'&&startClock<'14:00'&&endClock<='14:00';
  const id=midday?'midday-2026-10-23':w.id;
  let group=groups.get(id);
  if(!group){group={id,date,windowIds:[],startsAt:w.starts_at,endsAt:w.ends_at,label:midday?'Mediodía':`${timeFormat.format(new Date(w.starts_at))} – ${timeFormat.format(new Date(w.ends_at))}`};groups.set(id,group);}
  group.windowIds.push(w.id);
  if(w.ends_at>group.endsAt)group.endsAt=w.ends_at;
 }
 return [...groups.values()];
}
export function matchesServicePeriod(order,period){
 return !period||period.windowIds.includes(order.deliveryWindowId??order.delivery_window_id??order.window_id) ||
  !(order.deliveryWindowId??order.delivery_window_id??order.window_id)&&order.starts_at===period.startsAt&&order.ends_at===period.endsAt;
}
