import type {MenuRow} from './orders.js';
import type {Interpretation} from './order-assistant.js';
import type {ConversationContext} from '../types.js';
import {cop,normalizeText} from '../lib/format.js';
import {lineCharge,roundCop} from '../../admin-dashboard/src/costing/pricing.mjs';

type Edit=Interpretation['edits'][number];
export type CrabPortion={kind:'snow'|'king';baseGrams:number;wholeGrams:number;minGrams:number;maxGrams:number;rounding:number;saleMode?:'whole'|'weight'};
export const crabInstructions=`CANGREJO SUELTO: el cangrejo rey se ofrece por pata entera y el cangrejo de nieve por racimo entero (4 patas y pinza), con precio fijo por pieza según el catálogo. Nunca ofrezcas 100 g, medias patas ni cobro por peso. Los gramos son orientativos para preparación. Para cantidades de piezas usa portion={kind:'whole',amount:número de piezas,evidence:frase literal actual}; si dice 'cangrejo rey' o 'cangrejo de nieve' sin cantidad usa una pieza y conserva el picante elegido. Si pide explícitamente gramos o media pieza, no conviertas eso en una pieza más cara: deja quantity=null y explica la presentación disponible para que elija. No cambia el cangrejo incluido en los combos. Con pendingCrabPortions aplica la respuesta a la selección pendiente, sin duplicar artículos. Consultas de precio o composición no agregan productos. En respuestas generales sobre el menú empieza por los combos, sin enumerar precios de mariscos sueltos salvo que los pidan.`;

export function crabKind(item:MenuRow|undefined):'snow'|'king'|null {
 if(!item)return null;
 const meta=JSON.parse(item.metadata_json);
 if(!['g','piece'].includes(meta.kitchen?.product?.unit))return null;
 const slug=item.slug??meta.slug??'';
 return slug==='cangrejo_nieve_100g'?'snow':slug==='cangrejo_rey_100g'?'king':null;
}
export function attachCrabPortions(menu:MenuRow[],settings:Record<string,number>,ranges:any[]) {
 for(const item of menu){
  const kind=crabKind(item);if(!kind)continue;
  const meta=JSON.parse(item.metadata_json);
  if(meta.kitchen.product.unit==='piece'){
   const grams=meta.kitchen.product.components.filter((c:any)=>meta.kitchen.ingredients.some((i:any)=>i.id===c.ingredientId&&i.unit==='g')).reduce((sum:number,c:any)=>sum+c.quantity,0);
   meta.crabPortion={kind,baseGrams:grams,wholeGrams:grams,minGrams:grams,maxGrams:grams,rounding:1,saleMode:'whole'} satisfies CrabPortion;
   item.metadata_json=JSON.stringify(meta);continue;
  }
  const wholeGrams=settings[kind==='snow'?'snow_cluster_g':'king_leg_g'];
  const range=ranges.find(r=>r.slug===(item.slug??meta.slug));
  if(!wholeGrams||!range)continue; // Missing central configuration must never become a guessed weight.
  meta.crabPortion={kind,baseGrams:meta.kitchen.product.baseQuantity,wholeGrams,minGrams:range.minGrams,maxGrams:range.maxGrams,rounding:settings.rounding_cop??1} satisfies CrabPortion;
  item.metadata_json=JSON.stringify(meta);
 }
}
export function portionConfig(item:MenuRow):CrabPortion|undefined{return JSON.parse(item.metadata_json).crabPortion;}
export function refreshWholePieceDraft(context:ConversationContext,menu:MenuRow[]) {
 const changed:MenuRow[]=[];
 context.cart=(context.cart??[]).filter(line=>{
  const item=menu.find(i=>i.id===line.menuItemId);
  if(!item||portionConfig(item)?.saleMode!=='whole'||line.customization?.finalWeightPending===false)return true;
  changed.push(item);
  context.pendingCrabPortions=(context.pendingCrabPortions??[]).filter(e=>e.itemId!==item.id);
  context.pendingCrabPortions.push({operation:'add',itemId:item.id,lineId:null,quantity:null,portion:null,spice:line.customization?.spice as any??null,sauce:line.customization?.sauce as any??null});
  return false;
 });
 return changed;
}
export function crabExplanation(item:MenuRow,question=true){
 const c=portionConfig(item);if(!c)return `Para ${item.name}, ¿quieres 100 g o una pieza entera? El equipo debe revisar el peso y precio de la pieza entera.`;
 const label=c.kind==='snow'?'racimo entero':'pata entera';
 if(c.saleMode==='whole')return `${c.kind==='snow'?'🦀 Cangrejo de nieve · racimo entero (4 patas y pinza)':'🦀 Cangrejo rey · pata grande entera'}: ${cop(item.price_cop)} por pieza. Aprox. ${c.wholeGrams} g; precio fijo por pieza entera.${question?`\n\n¿Cuántos ${c.kind==='snow'?'racimos enteros':'patas enteras'} quieres?`:''}`;
 const range=(g:number)=>cop(roundCop(item.price_cop*g/c.baseGrams,c.rounding));
 return `${c.kind==='snow'?'🦀 Cangrejo de nieve':'🦀 Cangrejo rey'}:\n• 100 g: ${cop(lineCharge(item.price_cop,100/c.baseGrams))}. Es una porción por peso; ${c.kind==='snow'?'pueden ser unas patas pequeñas o trozos':'pueden ser trozos de pata'}, no una pieza entera garantizada.\n• ${c.kind==='snow'?'Racimo entero: patas y pinza unidas con parte del cuerpo':'Pata entera: una pata completa de cangrejo rey'}. Aprox. ${c.minGrams}–${c.maxGrams} g: ${range(c.minGrams)}–${range(c.maxGrams)}. Se cobra por el peso real a ${cop(item.price_cop)} por ${c.baseGrams} g.${question?`\n\n¿Prefieres 100 g o ${label}?`:''}`;
}

const counts:Record<string,number>={un:1,una:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,one:1,two:2,three:3,a:1};
function count(word:string){return counts[word]??Number(word.replace(',','.'));}
const wholeCountChoice=(text:string)=>/^(?:un|una|uno|dos|tres|[1-9]\d?)(?: por favor| porfa)?[.!]*$/i.test(text.trim())?{kind:'whole' as const,amount:count(text.trim().toLowerCase().split(' ')[0]!.replace(/[.!]/g,'')),evidence:text}:null;
// Evidence must describe a physical quantity in the customer's current message.
// Multiple alternatives, questions, and negations are intentionally not selections.
function parseChoice(text:string,kind:'snow'|'king') {
 const t=text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
 if(/\b(?:media|mitad|half|medio racimo|medio cangrejo)\b/.test(t))return null;
 if(/[?¿]/.test(t)||/\b(?:no|sin|not|without|cuanto|cuesta|precio|diferencia|versus)\b/.test(t))return null;
 if(/^(?:(?:el|la|uno|una) )?(?:entero|entera|completo|completa|whole)(?: por favor| porfa)?$/.test(t))return {kind:'whole' as const,amount:1,evidence:text};
 const weights=[...t.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(kg|kilos?|kilogramos?|g|gr|grs|gramos?|grams?)\b/g)];
 const whole=kind==='snow'?/\b(?:(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|one|two|three|a)\s+)?(?:racimos?|clusters?)(?:\s+(?:entero|completo|whole)s?)?\b/g:/\b(?:(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|one|two|three|a)\s+)?(?:patas?|legs?)(?:\s+(?:entera|completa|whole)s?)?\b/g;
 const pieces=[...t.matchAll(whole)];
 if(weights.length===1&&!pieces.length){const w=weights[0]!;const grams=count(w[1]!)*(w[2]!.startsWith('k')?1000:1);return grams>0&&grams<=10000?{kind:'grams' as const,amount:grams,evidence:text}:null;}
 if(!weights.length&&pieces.length===1){if(!pieces[0]![1]&&/\b(?:patas|legs|racimos|clusters)\b/.test(t))return null;const n=pieces[0]![1]?count(pieces[0]![1]!):1;return Number.isSafeInteger(n)&&n>0&&n<=100?{kind:'whole' as const,amount:n,evidence:text}:null;}
 return null;
}
export function prepareCrabEdits(text:string,plan:Interpretation,context:ConversationContext,menu:MenuRow[]) {
 const pending=[...(context.pendingCrabPortions??[])];
 const edits:Edit[]=[],notices:string[]=[];
 const requested=plan.edits.filter(e=>e.operation!=='remove'&&(e.operation==='add'||e.quantity!==null)&&!!crabKind(menu.find(i=>i.id===e.itemId)!));
 const ambiguous:Edit[]=[];
 // A short, explicit answer can resolve a saved choice even if the model misses it.
 const shortChoice=/^(?:(?:quiero|prefiero|mejor|el|la) )?(?:\d+(?:[.,]\d+)?\s*(?:g|gr|gramos?|kg)|(?:(?:un|una|uno|dos|tres|\d+) )?(?:racimos?|patas?|entero|entera)(?: (?:entero|entera|completo|completa)s?)?)(?: por favor| porfa)?[.!]*$/i.test(text.trim());
 if(pending.length===1||pending.length>1&&(shortChoice||wholeCountChoice(text))){
  const saved=pending[0]!,item=menu.find(i=>i.id===saved.itemId);
  const choice=item&&(parseChoice(text,crabKind(item)!)??(portionConfig(item)?.saleMode==='whole'?wholeCountChoice(text):null));
  if(choice&&['order','continue','clarify','question'].includes(plan.intent)&&(shortChoice||!!wholeCountChoice(text)||!plan.edits.some(e=>e.itemId!==saved.itemId))){
   plan={...plan,intent:'continue',reply:'',edits:[{...saved,portion:choice}]};
  }
 }
 for(const edit of plan.edits){
  const item=menu.find(i=>i.id===edit.itemId),kind=item&&crabKind(item);
  if(!item||!kind||edit.operation==='remove'||(edit.operation==='set'&&edit.quantity===null)){edits.push(edit);if(edit.operation==='remove'){const wasPending=pending.some(e=>e.itemId===edit.itemId);for(let i=pending.length-1;i>=0;i--)if(pending[i]!.itemId===edit.itemId)pending.splice(i,1);if(wasPending&&edit.lineId===null)edits.pop();}continue;}
  const config=portionConfig(item);
  let choice:ReturnType<typeof parseChoice>=null;
  if(edit.portion&&normalizeText(text).includes(normalizeText(edit.portion.evidence))){
   const evidenceChoice=parseChoice(edit.portion.evidence,kind)??(config?.saleMode==='whole'?wholeCountChoice(edit.portion.evidence):null);
   if(evidenceChoice?.kind===edit.portion.kind&&evidenceChoice.amount===edit.portion.amount)choice=evidenceChoice;
  }
  if(!choice&&plan.edits.filter(e=>e.operation==='add'||e.operation==='set'&&e.quantity!==null).length===1&&requested.length<=1)choice=parseChoice(text,kind);
  if(config?.saleMode==='whole'){
   const unsupported=choice?.kind==='grams'||(!choice&&/\b\d+(?:[.,]\d+)?\s*(?:g|gr|gramos?|kg)\b/i.test(text))||/\b(?:media|mitad|half|medio racimo|medio cangrejo)\b/i.test(normalizeText(text));
   if(unsupported)choice=null;
   else if(!choice&&!/[?¿]/.test(text)&&!/\b(?:no|sin|not|without|cuanto|cuesta|precio|versus)\b/.test(normalizeText(text))&&Number.isSafeInteger(edit.quantity)&&edit.quantity!>0)choice={kind:'whole',amount:edit.quantity!,evidence:text};
   if(choice&&choice.kind!=='whole')choice=null;
  }
  if(!choice||(!config&&choice.kind==='whole')){ambiguous.push({...edit,quantity:null,portion:null});continue;}
  const base=JSON.parse(item.metadata_json).kitchen.product.baseQuantity;
  const quantity=config?.saleMode==='whole'?choice.amount:choice.kind==='grams'?choice.amount/base:choice.amount*config!.wholeGrams/base;
  if(quantity>100){ambiguous.push({...edit,quantity:null,portion:null});continue;}
  const prior=pending.find(e=>e.itemId===edit.itemId);
  edits.push({...prior,...edit,spice:edit.spice??prior?.spice??null,quantity,portion:choice});
  for(let i=pending.length-1;i>=0;i--)if(pending[i]!.itemId===edit.itemId)pending.splice(i,1);
  if(choice.kind==='whole'&&config?.saleMode==='whole')notices.push(`${choice.amount} ${kind==='snow'?'racimo(s) entero(s) de cangrejo de nieve':'pata(s) entera(s) de cangrejo rey'}: ${cop(lineCharge(item.price_cop,quantity))}. Precio fijo por pieza.`);
  else if(choice.kind==='whole')notices.push(`${choice.amount} ${kind==='snow'?'racimo(s) entero(s) de cangrejo de nieve':'pata(s) entera(s) de cangrejo rey'}: aprox. ${quantity*base} g, ${cop(lineCharge(item.price_cop,quantity))} estimados. El precio final depende del peso real (${cop(item.price_cop)} / ${base} g).`);
 }
 for(const edit of ambiguous){const i=pending.findIndex(e=>e.itemId===edit.itemId);if(i>=0)pending[i]={...pending[i],...edit,spice:edit.spice??pending[i]!.spice};else pending.push(edit);}
 context.pendingCrabPortions=pending.length?pending:undefined;
 return {plan:{...plan,edits},notices};
}
