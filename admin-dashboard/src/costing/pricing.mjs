import {chargeFor} from './money.mjs';
// The only pricing engine. Preserve calculation precision; round only sale charges.
// No filesystem, database, secrets or network access in this module.
export class PricingError extends Error { constructor(message, status=400) { super(message); this.status=status; } }
const fail = (ok,msg) => { if (!ok) throw new PricingError(msg); };
const num=(v,min=0,max=1e12)=>typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
const money=v=>v===null || (Number.isSafeInteger(v)&&v>=0&&v<=2000000000);
export function evaluate(expr, settings, depth=0) {
  fail(expr && depth<20,'Relación de cantidad inválida.');
  if ('value' in expr) { fail(num(expr.value),'Cantidad inválida.'); return expr.value; }
  if ('ref' in expr) { fail(Object.hasOwn(settings,expr.ref)&&num(settings[expr.ref]),'Supuesto desconocido: '+expr.ref); return settings[expr.ref]; }
  fail(['+','-','*','/'].includes(expr.op)&&expr.args?.length===2,'Relación inválida.');
  const [a,b]=expr.args.map(e=>evaluate(e,settings,depth+1));
  fail(expr.op!=='/'||b>0,'No se puede dividir por cero.');
  const n=expr.op==='+'?a+b:expr.op==='-'?a-b:expr.op==='*'?a*b:a/b;
  fail(num(n),'Cantidad calculada fuera de rango.'); return n;
}
export const roundCop=(n,step=1)=>{ fail(num(n)&&num(step,Number.MIN_VALUE),'Precio inválido.'); return Math.round((n/step)+Number.EPSILON)*step; };
export const lineCharge=chargeFor;
const fmt=n=>new Intl.NumberFormat('es-CO',{maximumFractionDigits:3}).format(n);
const cop=n=>n===null?'Por definir':new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(n);
const pieceLabels={personal_shrimp_piece_g:'langostino(s)',black_mussel_piece_g:'mejillón(es) negro(s)',potato_g:'papa(s)',kanikama_piece_g:'pieza(s) de kanikama',snow_cluster_g:'racimo(s) de cangrejo de nieve',snow_leg_g:'pata(s) de cangrejo de nieve',king_leg_g:'pata(s) de cangrejo rey',king_small_g:'pata(s) pequeña(s) de cangrejo rey',shrimp_piece_g:'langostino(s)'};
export function pieceTerms(expr,multiplier=1) {
  if (expr.ref&&pieceLabels[expr.ref]) return [{setting:expr.ref,count:multiplier,label:pieceLabels[expr.ref]}];
  if(expr.op==='+') return expr.args.flatMap(e=>pieceTerms(e,multiplier));
  if(expr.op==='*') {const [a,b]=expr.args;if('value'in a)return pieceTerms(b,multiplier*a.value);if('value'in b)return pieceTerms(a,multiplier*b.value);}
  return [];
}
export function componentText(c) {
  if(c.pieces?.length) return `${c.pieces.map(p=>`${fmt(p.count)} ${p.label}`).join(' + ')} (${fmt(c.quantity)} ${c.unit})`;
  return `${fmt(c.quantity)} ${c.unit==='each'||c.unit==='piece'||c.unit==='pieza'?'unidad(es) de ':c.unit+' de '}${c.name}`;
}
export function validateModel(m) {
  for(const collection of ['settings','ingredients','recipes','lines','menu','heats','drinks','equipment','ranges']) fail(Array.isArray(m[collection]),'Datos incompletos: '+collection);
  for(const name of ['settings','ingredients','recipes','lines','menu','drinks','equipment']) {const keys=m[name].map(x=>x.key??x.slug); fail(new Set(keys).size===keys.length,'Identificadores duplicados.');}
  for(const i of m.ingredients) {
    fail(money(i.purchasePrice)&&num(i.purchaseQty,Number.MIN_VALUE)&&num(i.waste,0,.999999)&&['g','ml','each'].includes(i.unit),'Compra, unidad o merma inválida: '+i.name);
    fail(['Included','Add IVA'].includes(i.ivaMode)&&typeof i.freight==='boolean','IVA o transporte inválido.');
    fail(typeof i.displayName==='string'&&i.displayName.length>0&&i.displayName.length<=120,'Nombre de ingrediente inválido.');
  }
  for(const s of m.settings) {fail(num(s.value),'Supuesto inválido: '+s.key);if(['target_food_pct','target_drink_pct'].includes(s.key))fail(s.value>0&&s.value<=1,'El costo objetivo debe estar entre 0 y 100 %.');if(s.key==='iva_rate')fail(s.value<=1,'IVA inválido.');if(['delivery_kg','rounding_cop','combo_per_batch','personal_per_batch','sauce_batch_oz'].includes(s.key))fail(s.value>0,'El supuesto debe ser mayor que cero.');if(['rounding_cop','transport_cop'].includes(s.key))fail(money(s.value)&&s.value!==null,'Usa COP enteros.');}
  for(const r of m.recipes) {fail(num(r.yieldQty,Number.MIN_VALUE)&&typeof r.estimated==='boolean','Rendimiento inválido.');fail(m.lines.some(l=>l.recipeKey===r.key),'La receta necesita al menos un componente.');const refs=m.lines.filter(l=>l.recipeKey===r.key).map(l=>l.ingredientKey??l.subrecipeKey);fail(new Set(refs).size===refs.length,'Combina los ingredientes repetidos en una sola fila.');}
  for(const l of m.lines) {
    fail(m.recipes.some(r=>r.key===l.recipeKey),'Receta desconocida.');
    const i=m.ingredients.find(i=>i.key===l.ingredientKey), r=m.recipes.find(r=>r.key===l.subrecipeKey);
    fail(Boolean(i)!==Boolean(r),'El componente necesita un ingrediente o una subreceta.');
    fail(i ? l.unit===i.unit : ['piece','pieza'].includes(l.unit)&&r.unit==='piece','La unidad de la receta no coincide con su ingrediente.');
    fail(typeof l.consumable==='boolean','Categoría inválida.');
  }
  for(const i of m.menu) {fail(money(i.priceOverride)&&typeof i.name==='string'&&i.name.trim().length>0&&i.name.length<=120&&typeof i.description==='string'&&i.description.length<=1000&&typeof i.active==='boolean'&&Number.isSafeInteger(i.sortOrder),'Producto inválido.');fail(m.recipes.some(r=>r.key===i.recipeKey)&&['portion','extra'].includes(i.sauceMode),'Receta o salsa inválida.');}
  for(const d of m.drinks) fail(money(d.packPrice)&&money(d.priceOverride)&&num(d.servings,Number.MIN_VALUE)&&typeof d.active==='boolean'&&!(d.active&&d.example),'Bebida inválida. El ejemplo no se puede vender.');
  for(const e of m.equipment) fail(money(e.unitCost)&&num(e.quantity,Number.MIN_VALUE)&&num(e.expectedUses,Number.MIN_VALUE),'Equipo o vida útil inválidos.');
  for(const h of m.heats) fail(num(h.cayenneQty)&&h.chargeCop===0&&m.ingredients.some(i=>i.key===h.ingredientKey),'El picante está incluido: el cargo debe ser cero.');
  for(const r of m.ranges)fail(num(r.minGrams,Number.MIN_VALUE)&&num(r.maxGrams,r.minGrams)&&m.menu.some(i=>i.slug===r.slug),'Rango de pesos inválido.');
}
export function priceModel(input) {
  validateModel(input); const model=structuredClone(input), settings={};
  const pending=new Set(model.settings.map(s=>s.key));
  for(let pass=0;pass<model.settings.length;pass++) for(const s of model.settings) {
    if(!pending.has(s.key)||s.key==='cornbread_cost')continue;
    try {settings[s.key]=s.expression?evaluate(s.expression,settings):s.value;pending.delete(s.key);} catch(e){if(pass===model.settings.length-1)throw e;}
  }
  const ingredients=model.ingredients.map(i=>{
    const cost=i.purchasePrice===null||!i.purchaseQty?0:(i.purchasePrice*(i.ivaMode==='Add IVA'?1+settings.iva_rate:1)/i.purchaseQty+(i.freight&&i.unit==='g'?settings.freight_per_kg/1000:0))/(1-i.waste);
    return {...i,cost,missing:cost===0};
  });
  const byIngredient=new Map(ingredients.map(i=>[i.key,i])), byRecipe=new Map(model.recipes.map(r=>[r.key,r])), memo=new Map();
  function recipe(key,stack=[]) {
    if(memo.has(key))return memo.get(key);
    fail(!stack.includes(key)&&stack.length<15,'Las subrecetas tienen una dependencia circular.');
    const r=byRecipe.get(key);fail(r,'Subreceta desconocida.');
    const components=model.lines.filter(l=>l.recipeKey===key).map(l=>{
      const i=byIngredient.get(l.ingredientKey), sub=l.subrecipeKey?recipe(l.subrecipeKey,[...stack,key]):null;
      const qty=evaluate(l.expression??{value:l.qty},settings), cost=i?i.cost:sub.unitCost;
      return {...l,quantity:qty,name:i?.displayName??sub.name,unitCost:cost,lineCost:qty*cost,pieces:pieceTerms(l.expression??{}),missing:qty>0?(i?.missing?[i.key]:sub?.missing??[]):[],ingredientKeys:i?[i.key]:sub.ingredientKeys};
    });
    const result={...r,components,cost:components.reduce((s,l)=>s+l.lineCost,0),missing:[...new Set(components.flatMap(c=>c.missing))],ingredientKeys:[...new Set(components.flatMap(c=>c.ingredientKeys))]};
    result.unitCost=result.cost/r.yieldQty; memo.set(key,result);return result;
  }
  const bread=recipe('cornbread');settings.cornbread_cost=bread.unitCost;
  const sauce=recipe('house_sauce'),boil=recipe('boil');
  const target=(cost,pct)=>cost===0?null:roundCop(cost/pct,settings.rounding_cop);
  const heats=[...model.heats].sort((a,b)=>a.cayenneQty-b.cayenneQty).map(h=>({...h,cost:h.cayenneQty*byIngredient.get(h.ingredientKey).cost,missing:h.cayenneQty>0&&byIngredient.get(h.ingredientKey).missing}));
  const menu=model.menu.map(item=>{
    const r=recipe(item.recipeKey), portions=evaluate(item.sauceExpression,settings);
    const food=r.components.filter(c=>!c.consumable).reduce((s,l)=>s+l.lineCost,0),consumables=r.components.filter(c=>c.consumable).reduce((s,l)=>s+l.lineCost,0);
    // Actual Menu!F18 uses Sauces!D17 (without boil), verified against the workbook.
    const sauceCost=item.sauceMode==='extra'?sauce.unitCost*settings.combo_per_batch*settings.extra_sauce_oz/settings.sauce_batch_oz:portions*(sauce.unitCost+boil.unitCost);
    const total=food+sauceCost+consumables,atTarget=target(food+sauceCost,settings.target_food_pct),price=item.priceOverride??atTarget;
    fail(!item.active||price!==null,'Define un precio antes de activar '+item.name);
    fail(money(price),'Precio calculado fuera del límite de COP.');
    fail(r.components.some(c=>c.quantity>0),'La receta necesita cantidades mayores que cero.');
    const usesSauce=portions>0||item.sauceMode==='extra';
    const components=r.components.map(c=>({...c}));
    const includes=components.filter(c=>!c.consumable).map(c=>item.displayKanikamaPieces&&c.ingredientKey==='ingredient_7'?`${Math.ceil(c.quantity/settings.kanikama_piece_g)} piezas de kanikama`:componentText(c)).join(', ');
    const sauceOz=item.sauceMode==='extra'?settings.extra_sauce_oz:portions*settings.sauce_batch_oz/settings.combo_per_batch;
    return {...item,food_cost:food,sauce_portions:portions,sauce_cost:sauceCost,consumables,total_cost:total,price_at_target:atTarget,price_used:price,food_cost_pct:price? (food+sauceCost)/price:null,profit:price===null?null:price-total,components,sauceOz,
      missing:[...new Set([...r.missing,...(item.incompleteCosts??[]),...(usesSauce?sauce.missing:[]),...(portions>0?boil.missing:[])])],ingredientKeys:[...new Set([...r.ingredientKeys,...(usesSauce?sauce.ingredientKeys:[]),...(portions>0?boil.ingredientKeys:[])])],
      generatedDescription:[includes?includes+'.':'',usesSauce?`${fmt(sauceOz)} oz de salsa de la casa. Picante ${item.standardSpice||heats.map(h=>h.key).join(' o ')}.`:'',item.description].filter(Boolean).join(' ')};
  });
  const drinks=model.drinks.map(d=>{
    const cost=d.packPrice===null?0:d.packPrice/d.servings,atTarget=target(cost,settings.target_drink_pct),price=d.priceOverride??atTarget;
    fail(!d.active||price!==null,'Define el precio de la bebida antes de activarla.');
    return {...d,cost,price_at_target:atTarget,price_used:price,food_cost_pct:price?cost/price:null,profit:price===null?null:price-cost,missing:cost===0};
  });
  const equipment=model.equipment.map(e=>({...e,totalCost:(e.unitCost??0)*e.quantity,costPerDelivery:(e.unitCost??0)*e.quantity/e.expectedUses,missing:e.unitCost===null}));
  const ranges=model.ranges.map(r=>{const item=menu.find(i=>i.slug===r.slug);return {...r,minPrice:item?.price_used===null?null:item.saleUnit!=='g'?item.price_used:roundCop(item.price_used*r.minGrams/item.baseQuantity,settings.rounding_cop),maxPrice:item?.price_used===null?null:item.saleUnit!=='g'?item.price_used:roundCop(item.price_used*r.maxGrams/item.baseQuantity,settings.rounding_cop)};});
  return {settings,ingredients,recipes:[...memo.values()],menu,heats,drinks,equipment,ranges,sauceCostPerPortion:sauce.unitCost+boil.unitCost,cornbreadCostPerPiece:bread.unitCost,deliveryEquipmentCost:equipment.reduce((s,e)=>s+e.costPerDelivery,0)};
}
export function menuText(priced) {return priced.menu.filter(i=>i.active).map(i=>`*${i.name}* · ${cop(i.price_used)}${i.saleUnit==='g'?' / 100 g':''}\n${i.generatedDescription}`).concat(priced.drinks.filter(d=>d.active).map(d=>`*${d.name}* · ${cop(d.price_used)}`)).join('\n\n');}
