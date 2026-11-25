import { DateTime } from 'luxon';

export const cop = (amount: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(amount);

export const windowLabel = (startsAt: string, endsAt: string, timezone: string) => {
  const start = DateTime.fromISO(startsAt, { setZone: true }).setZone(timezone).setLocale('es');
  const end = DateTime.fromISO(endsAt, { setZone: true }).setZone(timezone).setLocale('es');
  return `${start.toFormat("cccc d 'de' LLL, h:mm a")}–${end.toFormat('h:mm a')}`;
};

export const deadlineLabel = (at: string, timezone: string) =>
  DateTime.fromISO(at, { setZone: true }).setZone(timezone).setLocale('es')
    .toFormat("cccc d 'de' LLLL, h:mm a");

export const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+57${digits}`;
  if (value.startsWith('+') && digits.length >= 8) return `+${digits}`;
  throw new Error('Número de teléfono inválido');
};

export const normalizeText = (value: string) =>
  value.trim().toLocaleLowerCase('es-CO').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

/** Show live capacity separately for each delivery window in business time. */
export const deliveryAvailability = (windows: Array<{starts_at:string;ends_at?:string;remaining:number;daily_remaining?:number;pickup_available?:boolean;prepayment_required?:boolean}>, timezone:string) => {
  return [...windows].sort((a,b)=>+new Date(a.starts_at)-+new Date(b.starts_at)).map(window=>{
    const start=DateTime.fromISO(window.starts_at,{setZone:true}).setZone(timezone).setLocale('es');
    const end=window.ends_at?DateTime.fromISO(window.ends_at,{setZone:true}).setZone(timezone).setLocale('es'):null;
    const remaining=Math.max(0,Math.min(Number(window.remaining),window.daily_remaining===undefined?Infinity:Number(window.daily_remaining)));
    const times=end?` (${start.toFormat('h:mm a')}–${end.toFormat('h:mm a')})`:'';
    return `• ${start.toFormat("cccc d 'de' LLLL")}${times}: ${window.pickup_available?'recogida disponible'+(window.prepayment_required?' · pago completo anticipado':''):window.prepayment_required?`${remaining} ${remaining===1?'cupo':'cupos'} · solo con pago completo por transferencia`:remaining===0?'agotado':remaining===1?'1 cupo disponible':`${remaining} cupos disponibles`}`;
  }).join('\n');
};
