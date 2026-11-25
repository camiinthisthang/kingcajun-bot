import {windowAvailable} from '../../admin-dashboard/src/booking-capacity.mjs';
import {pickupLocationNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';
import {deliveryAvailability,normalizeText} from '../lib/format.js';
import {DateTime} from 'luxon';

// Attached to every coverage map, using fresh bookable windows, not chat history.
export function coverageAvailabilityReply(windows:Array<{starts_at:string;ends_at?:string;remaining:number;daily_remaining?:number;pickup_available?:boolean;prepayment_required?:boolean}>,timezone:string,now=new Date()){
 const available=windows.filter(w=>windowAvailable(w)&&!w.pickup_available&&Math.min(w.remaining,w.daily_remaining??Infinity)>0);
 if(!available.length)return 'Por ahora no hay cupos de domicilio disponibles. Puedes pedir entrar en la lista de espera; si alguien cancela, te contactaremos. No hay una entrega reservada hasta confirmar el pedido.';
 const today=DateTime.fromJSDate(now).setZone(timezone).toISODate();
 const hasToday=available.some(w=>DateTime.fromISO(w.starts_at).setZone(timezone).toISODate()===today);
 const full=available.every(w=>w.prepayment_required);
 return `Entregas programadas, no inmediatas.${hasToday?'':' No tenemos entregas para hoy.'}\n${deliveryAvailability(available,timezone)}\n${full?'Por la alta demanda y para darte el mejor servicio, se reserva pagando el total por transferencia. Confirmamos al verificar el pago completo. ':''}Tú eliges la fecha y el horario.`;
}

export const liveAvailabilityInstructions=`DISPONIBILIDAD EN VIVO: las franjas suministradas ya excluyen fechas llenas, cerradas, vencidas o todavía no abiertas. Son la única fuente para ofrecer nuevas entregas. Si policies.fullPaymentRequired es true, el pedido completo se paga por transferencia, incluso si queda un cupo regular. No menciones abono ni contra entrega. Explica el motivo: por la alta demanda y para ofrecer el mejor servicio, los cupos restantes requieren pago completo anticipado. Las marcadas prepayment_required requieren pago COMPLETO por transferencia y verificación del equipo, nunca un abono ni pago contra entrega. Si se llenan los cupos regulares, ofrece pagar el total (solo cuando existen cupos adicionales) o entrar voluntariamente en la lista de espera para que el equipo contacte si alguien cancela. NUNCA sugieras recogida/pickup como alternativa a cupos llenos. La lista de espera no es un pedido ni un cupo reservado. Nunca reutilices fechas, horarios ni cupos de mensajes anteriores. Una fecha que aparecía en el historial puede haberse agotado. Si no hay franjas, no ofrezcas ninguna ni inventes la próxima. Si el cliente pregunta por una fecha ausente, explica que no hay cupos disponibles para esa fecha y ofrece únicamente las opciones actuales. Nunca elijas una fecha por el cliente. pickupWindows y pickup_available son franjas para recogida o mensajero propio: no consumen cupos de domicilio, pero sí respetan horarios y cierre. Solo usa esas opciones si el cliente pide explícitamente recogida o mensajero propio; nunca conviertas un domicilio en recogida para eludir un límite. Si cambia de modalidad, vuelve a comprobar las franjas de la modalidad nueva.`;

export const asksPickup = (text:string) => /\b(?:recoger|recogida|recojo|recogemos|pickup|mensajero propio)\b/.test(normalizeText(text));

const days='lunes|martes|miercoles|jueves|viernes|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
export function asksDeliveryAvailability(text:string){
 const t=normalizeText(text);
 return /\b(?:cupos?|franjas?|disponibilidad|horarios?)\b/.test(t)
  || /\b(?:que dias?|que fechas?|cuando|a que hora)\b.*\b(?:entreg|domicilio|llega|pedir|pido|pedido)/.test(t)
  || /\b(?:entreg|domicilio|llega)\w*\b.*\b(?:cuando|que dias?|que fechas?|hoy|manana|esta semana|fin de semana)\b/.test(t)
  || new RegExp(`\\b(?:entreg\\w*|domicilios?|disponible|hay|puede|puedo)\\b.*\\b(?:${days})\\b|\\b(?:${days})\\b.*\\b(?:entreg\\w*|disponible|hay|cupos?)\\b`).test(t);
}
// Free-form model replies must not offer dated delivery windows from old history.
// This only runs on AI replies, never on receipts for existing reservations.
export function mentionsDeliverySchedule(reply:string){
 const t=normalizeText(reply);
 return new RegExp(`\\b(?:${days}|hoy|manana)\\b`).test(t)
  || /\b\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(t)
  || /\b(?:franjas?|cupos?)\b/.test(t);
}
export function availableDeliveryReply(message:string,windows:Array<{starts_at:string;ends_at?:string;remaining:number;daily_remaining?:number;pickup_available?:boolean;prepayment_required?:boolean}>,timezone:string){
 const available=windows.filter(w=>windowAvailable(w)&&(w.pickup_available||Math.min(w.remaining,w.daily_remaining??Infinity)>0));
 if(!available.length)return 'Por ahora no quedan franjas de entrega con cupos disponibles. Puedes pedir entrar en la lista de espera; si alguien cancela, te contactaremos para saber si quieres hacer un pedido.';
 const asked=[...new Set(normalizeText(message).match(new RegExp(`\\b(?:${days})\\b`,'g'))??[])];
 const labels=deliveryAvailability(available,timezone);
 const spanish:Record<string,string>={monday:'lunes',tuesday:'martes',wednesday:'miercoles',thursday:'jueves',friday:'viernes',saturday:'sabado',sunday:'domingo'};
 const unavailable=asked.length===1&&!normalizeText(labels).includes(spanish[asked[0]!]??asked[0]!);
 if(available.every(w=>w.pickup_available))return 'Estas son las franjas para solicitar recogida en El Poblado:\n'+labels+'\n\nElige la fecha y el horario. '+pickupLocationNotice+' La recogida no ocupa cupo de domicilio.';
 return (unavailable?'Para ese día no hay franjas con cupos disponibles.\n\n':'')+'Estas son las franjas con cupos disponibles ahora:\n'+labels+'\n\nTú eliges la fecha y el horario; las opciones indicadas con pago completo se confirman al verificar la transferencia. También puedes pedir entrar en la lista de espera si tu fecha está llena.';
}
