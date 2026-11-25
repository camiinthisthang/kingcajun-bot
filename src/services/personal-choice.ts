import {normalizeText} from '../lib/format.js';
// Only block an unqualified first Personal selection. Subsequent contextual
// choices and edits retain their existing variant and are interpreted normally.
export function needsPersonalChoice(message:string,cart:Array<{menuItemId:string}>,menu:Array<{id:string;slug?:string|null}>,history:Array<{role?:string;text?:string}>){
 const variants=menu.filter(i=>i.slug?.startsWith('combo_personal'));
 if(variants.length<2||cart.some(l=>variants.some(i=>i.id===l.menuItemId)))return false;
 const text=normalizeText(message);
 const choice=/nieve|patas?|mejillon|langostin|camaron|ambos|ambas|uno de cada|una de cada/;
 if(!/\bpersonal(?:es)?\b/.test(text)||choice.test(text))return false;
 return !history.some(h=>h.role==='user'&&choice.test(normalizeText(h.text??'')));
}
