// Reporting dates are civil dates in Colombia, independent of the device zone.
export const bogotaDate=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
export function shiftDate(day,offset){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
export function currentWeek(now=new Date()){const today=bogotaDate(now),weekday=new Date(today+'T12:00:00Z').getUTCDay();const from=shiftDate(today,-((weekday+6)%7));return {from,to:shiftDate(from,6)};}
export function periodLabel(from,to){const format=d=>new Intl.DateTimeFormat('es-CO',{day:'numeric',month:'short',year:'numeric',timeZone:'America/Bogota'}).format(new Date(d+'T12:00:00Z'));return from&&to?`${format(from)} – ${format(to)}`:from?`Desde ${format(from)}`:to?`Hasta ${format(to)}`:'Todo el historial';}
