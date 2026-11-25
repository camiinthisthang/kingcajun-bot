import {applyCartEdits,type Interpretation} from './order-assistant.js';
import {prepareCrabEdits} from './crab-portions.js';
import {normalizeText} from '../lib/format.js';
import type {ConversationContext,InboundMessage} from '../types.js';
import type {MenuRow} from './orders.js';

export function flagCheckout(context:ConversationContext,note:string){
 const notes=context.checkoutReviewNotes??=[];
 if(note.trim()&&!notes.includes(note.trim().slice(0,240))&&notes.length<12)notes.push(note.trim().slice(0,240));
}

// Preserve literal requests and known prices. Unresolved changes are recorded,
// never converted into invented products, discounts, dates or payments.
export function fastCheckoutCart(message:InboundMessage,plan:Interpretation,context:ConversationContext,menu:MenuRow[],linked:boolean,standardSpice:string){
 for(const note of plan.reviewNotes??[])flagCheckout(context,note);
 if(plan.intent==='clarify')flagCheckout(context,`Detalle por revisar: ${message.text}`);
 let edits=structuredClone(plan.edits);
 const original=menu.find(i=>i.slug==='combo_personal');
 const text=normalizeText(message.text);
 const genericPersonal=original&&/\bpersonal(?:es)?\b/.test(text)&&!/[?¿]/.test(text)&&! /\b(no|sin|cuanto|precio|cuesta|mejillon\w*|doble|mas|extra|nieve|patas?)\b/.test(text);
 if(genericPersonal&&!context.cart?.some(l=>menu.find(i=>i.id===l.menuItemId)?.slug?.startsWith('combo_personal'))){
  // Owner-approved original is the default only for an unqualified Personal.
  const personalEdits=edits.filter(e=>menu.find(i=>i.id===e.itemId)?.slug?.startsWith('combo_personal'));
  if(personalEdits.length<=1){
   if(personalEdits.length)personalEdits[0]!.itemId=original.id;
   else {
    const match=text.match(/\b(un|uno|una|dos|tres|cuatro|\d+)\s+(?:combo\s+)?personales?\b/);
    const quantity=match?({un:1,uno:1,una:1,dos:2,tres:3,cuatro:4}[match[1]!]??Number(match[1])):1;
    edits.push({operation:'add',itemId:original.id,lineId:null,quantity,spice:null,sauce:null});
   }
   flagCheckout(context,'Personal sin variante indicada: registrado original con 2 patas de nieve; confirmar preferencia.');
  }
 }
 edits=edits.map(e=>{
  if(e.operation==='add'&&e.quantity===null&&!e.portion){flagCheckout(context,`Cantidad no indicada para ${menu.find(i=>i.id===e.itemId)?.name??e.itemId}: se registró 1.`);e.quantity=1;}
  if(e.spice&&standardSpice&&e.spice!==standardSpice){flagCheckout(context,`Solicita picante ${e.spice}; preparación de catálogo ${standardSpice}. Revisar con cocina.`);e.spice=standardSpice as any;}
  if(e.sauce&&linked&&e.sauce!=='Salsa de la casa'){flagCheckout(context,`Solicita ${e.sauce}; registrada salsa de la casa, revisar modificación.`);e.sauce='Salsa de la casa';}
  return e;
 });
 const prepared=prepareCrabEdits(message.text,{...plan,edits,intent:'continue'},context,menu);
 if(context.pendingCrabPortions?.length){
  flagCheckout(context,`Cangrejo pendiente de presentación/cantidad, no incluido en el total: ${context.pendingCrabPortions.map(e=>menu.find(i=>i.id===e.itemId)?.name??e.itemId).join(', ')}. Solicitud: ${message.text}`);
  delete context.pendingCrabPortions;
 }
 const cart=context.cart??[];
 const valid=prepared.plan.edits.filter(e=>{
  try{applyCartEdits(cart,[e],menu,linked);return true;}
  catch{flagCheckout(context,`Cambio sin aplicar, requiere revisión: ${message.text}`);return false;}
 });
 try{context.cart=applyCartEdits(cart,valid,menu,linked);}
 catch{flagCheckout(context,`Cambios incompatibles; conservada selección anterior: ${message.text}`);context.cart=cart;}
 context.cart=context.cart.map(l=>menu.find(i=>i.id===l.menuItemId)?.category==='plate'?{...l,customization:{...l.customization,sauce:l.customization?.sauce??'Salsa de la casa',spice:l.customization?.spice??(standardSpice||'Suave')}}:l);
 return context;
}
