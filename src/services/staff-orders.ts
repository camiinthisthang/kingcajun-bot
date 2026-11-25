import type { Config } from '../config.js';
import type { Db, DbClient } from '../db/index.js';
import type { ConversationContext } from '../types.js';
import { CashOnDeliveryPaymentProvider } from '../providers/payment.js';
import { OrderService } from './orders.js';
import { coverageSnapshot, locationFromAddress } from './delivery-coverage.js';

type StaffEvent = {phone:string; sentAt:string};
const review = (message:string):never => {throw Object.assign(new Error(message),{status:409});};

// Called inside the staff-event transaction. A complete saved draft goes through
// the same pricing, capacity, deposit and kitchen snapshot checks as checkout.
export function staffDraftCreator(cfg:Config) {
  return async (tx:DbClient,event:StaffEvent) => {
    if(cfg.PAYMENT_PROVIDER!=='cash_on_delivery')return review('Este borrador necesita revisión del método de pago.');
    const row=(await tx.query<{context_json:ConversationContext;updated_at:string}>('SELECT context_json,updated_at FROM conversations WHERE phone_e164=$1 FOR UPDATE',[event.phone])).rows[0];
    const c=row?.context_json;
    if(!row||!c?.orderingOptIn||!c.cart?.length)return review('No hay un borrador de pedido activo para confirmar.');
    // Meta echo timestamps only have second precision.
    if(+new Date(row.updated_at)>+new Date(event.sentAt)+999)return review('El borrador cambió después de la confirmación. Revisa los datos y envía CONFIRMADO de nuevo.');
    if(!c.windowId)return review('Falta la fecha y franja elegidas por el cliente.');
    if(!c.deliveryAddress||c.deliveryAddress.trim().length<8)return review('Falta la dirección completa acordada con el cliente.');
    if(c.pendingReferralCode||c.pendingSelection||c.pendingCrabPortions?.length)return review('Hay productos o un código pendientes de aclarar.');
    if(c.menuVersion===undefined)return review('Revisa el menú y el precio del borrador antes de confirmar.');
    const db:Db={...tx,transaction:async work=>work(tx),close:async()=>{}};
    const orders=new OrderService(db,cfg,new CashOnDeliveryPaymentProvider());
    await orders.loadMenu();
    for(const line of c.cart){
      const item=orders.menu().find(i=>i.id===line.menuItemId||i.slug===line.menuItemId);
      if(!item)return review('Un producto ya no está disponible; revisa el borrador.');
      if(item.category==='plate'&&!['Suave','Medio'].includes(line.customization?.spice??''))return review('Falta elegir Suave o Medio para cada plato.');
    }
    const coverage=coverageSnapshot(c.deliveryLocation??locationFromAddress(c.deliveryAddress),c.deliveryPreference);
    // Manual approval may proceed with a partial contact list. Keep supplied
    // contacts and the customer's explicit one-number exception for reminders.
    if(c.deliveryContactPhones?.length)coverage.contactPhones=[...new Set(c.deliveryContactPhones.filter(p=>/^\+[1-9]\d{7,14}$/.test(p)))].slice(0,2);
    if(c.deliverySingleContactAccepted&&coverage.contactPhones?.length===1)coverage.singleContactAccepted=true;
    // Even an automatically recognized location gets a recorded staff review.
    coverage.needsReview=true;
    // Match the kitchen's lock order before checkout locks the delivery window.
    await tx.query("SELECT id FROM kitchen_runs WHERE delivery_date=(SELECT (starts_at AT TIME ZONE 'America/Bogota')::date FROM delivery_windows WHERE id=$1) FOR UPDATE",[c.windowId]);
    try{
      const created=await orders.create({phone:event.phone,fullPrepayment:c.fullPrepayment,cart:c.cart,fulfillmentType:'delivery',windowId:c.windowId,
        deliveryAddress:c.deliveryAddress,deliveryCoverage:coverage,referralCode:c.referralCode,
        expectedMenuVersion:c.menuVersion,expectedTotalCop:c.reviewTotalCop??(await orders.quote(c.cart,c.referralCode,c.deliveryPreference)).total});
      return created.orderId;
    }catch(error){
      // Database failures must roll back the event for webhook retry.
      if(error instanceof Error&&!('code' in error))return review(error.message);
      throw error;
    }
  };
}
