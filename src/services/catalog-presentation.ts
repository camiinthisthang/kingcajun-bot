import {normalizeText,cop} from '../lib/format.js';

type Item={name:string;priceCop:number;aliases?:string[];crabPortion?:any;[key:string]:any};
const combo=(item:Item)=>/^combo\b/i.test(item.name);
export function asksIndividualPrice(message:string){
 const t=normalizeText(message);
 return /\b(?:cuanto|cuesta|cuestan|precio|precios|vale|valen|valor|costo|price|cost|how much)\b/.test(t)
  && /\b(?:cangrejo|king crab|snow crab|racimo|pata|langosta|lobster|langostino|kanikama|camaron|mazorca|papa|salchicha|huevo|pan|salsa|coca|gaseosa|kit|guantes|babero)\b/.test(t);
}
export function generalMenuContext(menu:Item[],message:string){
 if(asksIndividualPrice(message))return menu;
 return menu.map(item=>{
  if(combo(item))return item;
  const {priceCop,crabPortion,...rest}=item;
  return {...rest,...(crabPortion?{crabPortion:{kind:crabPortion.kind,saleMode:crabPortion.saleMode,explanation:crabPortion.kind==='king'?'Se vende por pata entera.':'Se vende por racimo entero: 4 patas y pinza.'}}:{})};
 });
}
export function comboFirstReply(reply:string,message:string,menu:Item[],orderLabel:string){
 if(asksIndividualPrice(message))return reply;
 // A model cannot publish an unsolicited loose-seafood price list, even if it
 // remembers numbers from earlier messages rather than the redacted context.
 const nonComboPrices=menu.filter(i=>!combo(i)).map(i=>String(i.priceCop));
 const numbers=[...reply.matchAll(/\d[\d.,]*/g)].map(m=>m[0].replace(/[.,]/g,''));
 const overview=/\bcomo\b.*\b(?:pedir|pedido|ordenar|comprar)\b|\bque\b.*\b(?:opciones|venden|comer)\b/.test(normalizeText(message));
 if(!overview&&!numbers.some(n=>nonComboPrices.includes(n)))return reply;
 const combos=menu.filter(combo);
 if(!combos.length)return reply;
 let body='Tenemos '+combos.map(i=>`${i.name} (${cop(i.priceCop)})`).join(', ')+'.';
 const t=normalizeText(message);
 if(/\b(?:rey|king crab)\b/.test(t)&&combos.some(i=>/premium/i.test(i.name)&&/rey/i.test(i.description??'')))body+=' El Premium incluye cangrejo rey.';
 if(/\b(?:langosta|lobster)\b/.test(t)&&menu.some(i=>/langosta/i.test(i.name)))body+=' También tenemos cola de langosta entera.';
 return body+' Para pedir, dime aquí qué te gustaría ordenar.';
}
