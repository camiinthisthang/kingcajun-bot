import {reminderPolicyNotice} from './reminder-confirmations.mjs';

export const pickupLocationNotice='La recogida es en Calle 3S #43A-40, El Poblado, Medellín, al lado del Hotel Estelar.';

export function deliveryWindowNotice(coverage={}){
 const method=coverage?.method??coverage?.preference;
 if(method==='pickup')return '📦 Recoge tu pedido dentro de la franja acordada. '+pickupLocationNotice;
 if(method==='own_courier')return '📦 Coordina con tu mensajero la recogida dentro de la franja acordada. '+pickupLocationNotice;
 return '🚚 Tu pedido puede llegar en cualquier momento dentro de la franja elegida. No podemos garantizar una hora exacta; asegúrate de que alguien esté disponible para recibirlo durante toda la franja.';
}

// Keep every confirmation path consistent, including deposits and staff commands.
// Orders are only warned about automatic cancellation when enrolled in that policy.
export function orderConfirmationNotice(order,now=new Date()){
 return [deliveryWindowNotice(order.delivery_coverage),reminderPolicyNotice(order.starts_at,now,order.reminder_confirmation_required===true)].filter(Boolean).join('\n\n');
}
