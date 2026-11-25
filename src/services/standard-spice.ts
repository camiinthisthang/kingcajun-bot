import type {CartLine} from '../types.js';
export function withStandardSpice(cart:CartLine[],menu:Array<{id:string;category:string}>,spice:string){
 if(!spice)return cart;
 return cart.map(line=>menu.find(i=>i.id===line.menuItemId)?.category==='plate'?{...line,customization:{...line.customization,spice}}:line);
}
export const standardSpiceNotice=(spice:string)=>`Por ahora todos nuestros platos se preparan con picante ${spice.toLowerCase()}. No ofrecemos otros niveles.`;
