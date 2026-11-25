import {packingBatchHeading} from './kitchen-search.js?v=batch-names-20261024';
import {routeTrip} from './route-trips.js';
// Chef-facing counts. Saved recipes, prices, and packing checks remain untouched.
const num = value => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(value);
const clean = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const whole = value => Math.ceil(value - 1e-8);
const matches = (ingredient, key, pattern) => (ingredient.id || ingredient.ingredientId || '').startsWith(key + '_') || pattern.test(clean(ingredient.name));
export const isKanikama = i => matches(i, 'ingredient_7', /kanikama|imitacion de cangrejo/);
export const isShrimp = i => matches(i, 'ingredient_8', /^langostinos?$|^camarones?$/);
export const isCorn = i => i.id === 'test-half-corn' || matches(i, 'ingredient_9', /^mazorca$/);
export const isSausage = i => matches(i, 'ingredient_11', /^salchicha(?: ranchera)?$/);
const isPackaging = i => /bandeja|vaso|tapa|babero|mantel|guante|bolsa|empaque|cubierto|servilleta/.test(clean(i.name));
const isCoke = i => /^coca[ -]?cola\b/.test(clean(i.name));
const isBib = i => /\bbabero\b/.test(clean(i.name));
// These are dispatch supplies, not food checks; retain them in orders and prep.
export const isPackingSupply = i => /^(?:kit\b|coca[ -]?cola\b|bebida\b|gaseosa\b)|\b(?:babero|mantel|guantes?)\b/.test(clean(i.name));

export function preparationSupplies(batch) {
  const count = predicate => (batch.totals || []).filter(predicate).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return [
    { name: 'Coca-Cola', quantity: count(isCoke), unit: 'unidades', detail: 'Bebidas incluidas en estos pedidos.' },
    { name: 'Kits de babero', quantity: count(isBib), unit: 'kits', detail: 'Babero, mantel y un par de guantes por kit.' },
  ];
}
const isKingCrab = i => /cangrejo rey/.test(clean(i.name));

export function kingCrabPrepCard(orders, definitions, totalGrams) {
  let legs = 0, wholeGrams = 0;
  for (const order of orders) {
    const source = order.kingCrabWholePieces;
    for (const p of source || []) {
      const snap = p.snapshot;
      const grams = (snap?.product?.components || []).filter(c => isKingCrab((snap.ingredients || []).find(i => i.id === c.ingredientId) || c)).reduce((n,c) => n+c.quantity,0) * (snap?.quantity / snap?.product?.baseQuantity);
      if (Number(p.count) > 0 && grams > 0) { legs += Number(p.count); wholeGrams += grams; }
    }
    for (const line of order.lines) for (const c of line.components || []) {
      if (!isKingCrab(definitions.find(i => i.id === c.ingredientId) || c)) continue;
      // Whole a-la-carte legs come from explicit sale metadata; combo legs
      // come from recipe piece references. Never turn a gram portion into a leg.
      if (source?.length && /pata entera/i.test(line.name)) continue;
      const pieces = (c.pieces || []).filter(p => p.setting === 'king_leg_g');
      const count = pieces.reduce((n,p) => n + p.count, 0);
      if (count > 0) { legs += count; wholeGrams += c.quantity; }
      else if (!source?.length && line.unit === 'piece' && /pata entera/i.test(line.name)) {
        legs += line.quantity / line.baseQuantity; wholeGrams += c.quantity;
      }
    }
  }
  const extra = Math.max(0, totalGrams - wholeGrams);
  const parts = [];
  if (legs) parts.push(`${num(legs)} ${legs === 1 ? 'pata entera' : 'patas enteras'}`);
  if (extra > .001) parts.push(`${num(extra)} g adicionales`);
  return { name:'Cangrejo rey', amount:parts.join(' + ') || `${num(totalGrams)} g`,
    detail: extra > .001 ? `Referencia visual: ${extra < 150 ? 'menos de ½ pata' : `${num(Math.floor(extra / 150))} ${Math.floor(extra / 150) === 1 ? 'media pata' : 'medias patas'}${extra % 150 > .001 ? ` + ${num(extra % 150)} g` : ''}`}. ½ pata ≈ 150 g; conservar los gramos indicados.` : 'Patas enteras según los pedidos. Referencia: ½ pata ≈ 150 g.', kind:'king-crab-legs' };
}
const isSauceLid = i => matches(i, 'ingredient_34', /^tapa de vaso/);
const isSauceCup = i => matches(i, 'ingredient_35', /^vaso de salsa/);

export function kitchenDate(date) {
  const value = new Date(`${date}T12:00:00-05:00`);
  if (!Number.isFinite(+value)) return String(date || 'Sin fecha');
  const label = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'long', month: 'long', day: 'numeric' }).format(value);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function ordersInBatch(run, batchId = 'all') {
  const active = run.orders.filter(order => !order.cancelled);
  if (batchId === 'all') return active;
  if (batchId === 'unassigned') {
    const known = new Set((run.deliveryWindows || []).map(w => w.id));
    return active.filter(o => !known.has(o.deliveryWindowId));
  }
  const windows = run.preparation?.find(b => b.id === batchId)?.windowIds || [batchId];
  return active.filter(o => windows.includes(o.deliveryWindowId));
}

export function packingProgress(run, batchId = 'all') {
  const orders = ordersInBatch(run, batchId);
  return { total: orders.length, packed: orders.filter(o => {
    const groups = [...new Set(o.lines.map(l => l.bag))];
    return groups.length > 0 && groups.every(group => run.packed[`${o.id}:${group}`]);
  }).length };
}

// Keep a customer's entire order together while retaining its saved spice and
// packing checks. Parts are only subsections inside the one order card.
export function orderCards(run) {
  return ordersInBatch(run).map(order => {
    const parts = (run.bags || []).filter(part => part.orderId === order.id);
    return { order, parts, packed: parts.length > 0 && parts.every(part => part.packed) };
  }).filter(card => card.parts.length);
}

export function packingSections(bags) {
  const result = [], combined = new Map();
  const comboCounts = new Map();
  for (const bag of bags) for (const line of bag.lines.filter(comboType)) comboCounts.set(bag.orderId,(comboCounts.get(bag.orderId)||0)+line.quantity/line.baseQuantity);
  for (const bag of bags) {
    const combos=bag.lines.filter(comboType);
    if (comboCounts.get(bag.orderId) === 1 && bag.lines.every(l=>comboType(l)||isPackingSupply(l))) { result.push({...bag,packingLabel:packingProductSummary(combos)[0],perCombo:true,repeatCount:1}); continue; }
    if (!combos.length) { result.push({...bag,packingLabel:'Adiciones aparte'}); continue; }
    const groups=combos.map(line=>({lines:[line],label:packingProductSummary([line]).join(''),id:line.productId}));
    const extras=bag.lines.filter(l=>!comboType(l)&&!isPackingSupply(l));
    if(extras.length)groups.push({lines:extras,label:'Adiciones aparte',id:'extras'});
    for(const group of groups){
      const line=group.lines[0],isCombo=!!comboType(line),count=isCombo?line.quantity/line.baseQuantity:1;
      const normalized=group.lines.map(l=>({...l,quantity:l.quantity/count,sauceOz:l.sauceOz==null?null:l.sauceOz/count,components:l.components.map(c=>({...c,quantity:c.quantity/count,pieces:(c.pieces||[]).map(p=>({...p,count:p.count/count}))}))}));
      const identity=JSON.stringify({order:bag.orderId,type:isCombo?comboType(line):group.id,components:normalized.flatMap(l=>l.components).map(c=>({id:c.ingredientId,q:c.quantity,p:c.pieces})).sort((a,b)=>a.id.localeCompare(b.id))});
      let hash=2166136261;for(const char of identity)hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
      const key=`${bag.orderId}:serving:${hash.toString(16)}`;
      if(isCombo&&combined.has(identity)){
        const saved=combined.get(identity);saved.repeatCount+=count;saved.sourceBagKeys.push(bag.key);saved.packed=!!saved.packed&&!!bag.packed;
        saved.heatCounts.push({heat:bag.heat,count});continue;
      }
      const amounts=new Map();for(const c of normalized.flatMap(l=>l.components)){
        const value=amounts.get(c.ingredientId)||{quantity:0,pieces:[]};value.quantity+=c.quantity;
        for(const p of c.pieces){const old=value.pieces.find(x=>x.setting===p.setting);if(old)old.count+=p.count;else value.pieces.push({...p});}amounts.set(c.ingredientId,value);
      }
      const part={...bag,key,sourceBagKey:bag.key,sourceBagKeys:[bag.key],packingLabel:isCombo?packingProductSummary(normalized)[0].replace(/ × 1$/,''):group.label,repeatCount:count,perCombo:isCombo,heatCounts:[{heat:bag.heat,count}],lines:normalized,includesSauce:normalized.some(l=>l.includesSauce),requirements:[...amounts].map(([id,value])=>{
        const original=bag.requirements.find(i=>i.id===id);return{...original,...value,packQuantity:original.unit==='piece'?value.quantity*(original.packFactor||1):null,target:original.target==null?null:original.target*value.quantity/original.quantity};
      })};
      result.push(part);if(isCombo)combined.set(identity,part);
    }
  }
  return result;
}

export function cornCutsForLines(lines, definitions) {
  let wholeCobs = 0, halfCobs = 0, quarterCobs = 0, found = false, supported = true;
  for (const line of lines) for (const component of line.components || []) {
    const ingredient = definitions.find(i => i.id === component.ingredientId) || component;
    if (!isCorn(ingredient)) continue;
    found = true;
    if (ingredient.unit !== 'piece' || (ingredient.packFactor || 1) !== 1) { supported = false; continue; }
    const portions = line.unit === 'portion' || line.unit === 'piece' ? line.quantity / line.baseQuantity : 1;
    const units = Number.isInteger(portions) && portions > 0 ? portions : 1;
    const cobs = component.quantity / units / (ingredient.id === 'test-half-corn' ? 2 : 1);
    if (!(cobs >= 0) || Math.abs(cobs * 4 - Math.round(cobs * 4)) > 1e-8) { supported = false; continue; }
    const quarters = Math.round(cobs * 4);
    wholeCobs += Math.floor(quarters / 4) * units;
    halfCobs += Math.floor((quarters % 4) / 2) * units;
    quarterCobs += quarters % 2 * units;
  }
  return { found, supported, wholeCobs, halfCobs, min: wholeCobs * 4 + halfCobs * 2 + quarterCobs, max: wholeCobs * 4 + halfCobs * 2 + quarterCobs };
}

export function cornCutCard(cuts) {
  return { name: 'Mazorca', kind: 'corn-cuts', amount: `${num(cuts.max)} pedazos`, detail: '4 pedazos por mazorca entera · 2 por media mazorca.' };
}

export function cutPackingPlan(item, lines, definitions) {
  if (isCorn(item)) {
    const cuts = cornCutsForLines(lines, definitions);
    if (cuts.found && cuts.supported) return { ...cornCutCard(cuts), min: cuts.min, max: cuts.max };
  }
  if (isSausage(item) && item.unit === 'piece' && (item.packFactor || 1) === 1 && Number.isInteger(item.quantity * 4)) {
    const pieces = item.quantity * 4;
    return { name: item.name, amount: `${num(pieces)} ${pieces === 1 ? 'pedazo' : 'pedazos'}`, detail: `${num(item.quantity)} ${item.quantity === 1 ? 'salchicha entera' : 'salchichas enteras'} · 4 pedazos por salchicha.`, kind: 'sausage-cuts', min: pieces, max: pieces };
  }
  return null;
}

// The chef enters cut pieces. Existing storage and validation continue using
// the whole-ingredient recipe units, with no changes to sold quantities.
export function packingActual(item, lines, definitions, entered) {
  const plan = cutPackingPlan(item, lines, definitions), actual = Number(entered);
  if (!plan) return actual;
  if (!Number.isInteger(actual) || actual < plan.min || actual > plan.max) throw new Error(`${item.name}: comprueba ${plan.amount}.`);
  return item.packQuantity ?? item.quantity * (item.packFactor || 1);
}

function pieceReference(components) {
  const ratios = components.flatMap(c => {
    if (!c.pieces?.length || !c.pieces.every(p => p.setting === 'kanikama_piece_g')) return [];
    const count = c.pieces.reduce((s, p) => s + p.count, 0);
    return c.quantity > 0 && count > 0 ? [c.quantity / count] : [];
  });
  if (!ratios.length || ratios.some(r => Math.abs(r - ratios[0]) > .000001)) return null;
  return ratios[0];
}

export function kanikamaContext(run, catalog = { products: [] }) {
  const saved = run.orders.filter(o => !o.cancelled).flatMap(o => o.lines.flatMap(l => l.components));
  const definitions = [...(run.ingredients || []), ...(catalog.ingredients || [])];
  const matchesKanikama = c => isKanikama(definitions.find(i => i.id === c.ingredientId) || c);
  const savedKanikama = saved.filter(matchesKanikama);
  // A sold piece definition wins over today's menu. Conflicting saved definitions
  // are not silently replaced by a newer reference.
  const hasSavedPieces = savedKanikama.some(c => c.pieces?.some(p => p.setting === 'kanikama_piece_g'));
  const gramsPerStick = hasSavedPieces ? pieceReference(savedKanikama) : pieceReference((catalog.products || []).flatMap(p => p.components).filter(matchesKanikama));
  return { gramsPerStick, definitions };
}

export function kanikamaForLines(lines, context) {
  let count = 0, estimated = false, unresolved = false, found = false;
  for (const line of lines) for (const c of line.components || []) {
    const ingredient = context.definitions.find(i => i.id === c.ingredientId) || c;
    if (!isKanikama(ingredient)) continue;
    found = true;
    const pieces = c.pieces?.filter(p => p.setting === 'kanikama_piece_g') || [];
    if (pieces.length) { count += pieces.reduce((sum, p) => sum + p.count, 0); continue; }
    if (ingredient.unit === 'piece') { count += c.quantity; continue; }
    if (ingredient.unit !== 'g' || !(context.gramsPerStick > 0)) { unresolved = true; continue; }
    // Round each whole combo separately so the total covers every plate.
    const portions = line.unit === 'portion' || line.unit === 'piece' ? line.quantity / line.baseQuantity : 1;
    const units = Number.isInteger(portions) && portions > 0 ? portions : 1;
    count += whole(c.quantity / units / context.gramsPerStick) * units;
    estimated = true;
  }
  return { found, count, estimated, unresolved };
}

export function kanikamaCard(counts) {
  return { name: 'Kanikama', amount: counts.unresolved ? 'Conteo por revisar' : `${counts.estimated ? '≈ ' : ''}${num(counts.count)} ${counts.count === 1 ? 'palito' : 'palitos'}`,
    detail: counts.unresolved ? 'Falta una referencia de piezas para convertir toda la receta.' : counts.estimated ? 'Estimado · redondeado hacia arriba por porción.' : '', kind: 'kanikama' };
}

export function shrimpCard(count, grams = count * 100 / 7) {
  const bags = Math.ceil(Math.max(0, grams) / (2000 * 0.9));
  return { name: 'Langostinos · sacar a descongelar', amount: `${num(bags)} ${bags === 1 ? 'bolsa' : 'bolsas'} de 2 kg`, detail: `Con 10% de merma por hielo: 1,8 kg útiles por bolsa. Redondeado hacia arriba. Objetivo al empacar: ${num(count)} langostinos.`, kind: 'shrimp' };
}

export function shrimpForLines(lines, definitions, gramsPerShrimp = 100 / 7) {
  let grams = 0, count = 0;
  for (const line of lines) for (const component of line.components || []) {
    const ingredient = definitions.find(i => i.id === component.ingredientId) || component;
    if (!isShrimp(ingredient) || ingredient.unit !== 'g' || !(component.quantity > 0)) continue;
    const portions = line.unit === 'portion' || line.unit === 'piece' ? line.quantity / line.baseQuantity : 1;
    const units = Number.isInteger(portions) && portions > 0 ? portions : 1;
    grams += component.quantity;
    // New recipes carry explicit counts. Historical portions retain their original fallback.
    const explicit=(component.pieces||[]).filter(p=>['shrimp_piece_g','personal_shrimp_piece_g'].includes(p.setting));
    if(explicit.length){count+=explicit.reduce((n,p)=>n+p.count,0);continue;}
    // Owner-requested serving counts: 7 shrimp per 100 g, rounded per portion.
    if (Number.isFinite(gramsPerShrimp) && gramsPerShrimp > 0) count += Math.max(1, Math.round(component.quantity / units / gramsPerShrimp)) * units;
  }
  return { grams, count: Number.isFinite(gramsPerShrimp) && gramsPerShrimp > 0 ? count : null };
}

export function comboType(line) {
  const name = clean(line.name);
  if (/^combo (personal|pequeno)\b/.test(name)) return 'personal';
  if (/^combo mediano\b/.test(name)) return 'mediano';
  if (/^combo familiar\b/.test(name)) return 'familiar';
  if (/^combo premium\b/.test(name)) return 'premium';
  return null;
}

// Packing headings describe the purchased combos once; quantities and
// special ingredients remain in the ingredient checklist underneath.
export function packingProductSummary(lines) {
  const groups = new Map();
  for (const line of lines.filter(l => !isPackingSupply(l))) {
    const type = comboType(line);
    if (!type) {
      groups.set(Symbol(), `${line.name}${line.quantity !== line.baseQuantity ? ` × ${line.quantity / line.baseQuantity}` : ''}`);
      continue;
    }
    const name = type === 'personal' ? line.name.split('·')[0].trim() : `Combo ${type}`;
    const previous = groups.get(name);
    groups.set(name, { name, quantity: (previous?.quantity || 0) + line.quantity / line.baseQuantity });
  }
  return [...groups.values()].map(group => typeof group === 'string' ? group : `${group.name} × ${num(group.quantity)}`);
}

export function trayPlan(orders) {
  const combos = { personal: 0, mediano: 0, familiar: 0, premium: 0 }, customOrders = [];
  for (const order of orders.filter(o => !o.cancelled)) {
    let hasCombo = false;
    for (const line of order.lines) {
      const type = comboType(line);
      if (!type) continue;
      hasCombo = true;
      combos[type] += line.quantity / line.baseQuantity;
    }
    if (!hasCombo) customOrders.push(order.reference);
  }
  return { combos, small: combos.personal, medium: combos.mediano, large: combos.familiar + combos.premium, customOrders };
}

// One visual card for a cup/lid pair; unequal counts remain explicit.
export function combineSauceContainers(items) {
  const result = [], cups = items.filter(isSauceCup), lids = items.filter(isSauceLid);
  let added = false;
  for (const item of items) {
    if (!isSauceCup(item) && !isSauceLid(item)) { result.push(item); continue; }
    if (added) continue;
    added = true;
    const cupCount = cups.reduce((s, c) => s + c.quantity, 0), lidCount = lids.reduce((s, c) => s + c.quantity, 0);
    result.push({ name: 'Vaso de salsa con tapa', quantity: cupCount, unit: 'piece', presentation: {
      name: 'Vaso de salsa con tapa', amount: cupCount === lidCount ? `${num(cupCount)} ${cupCount === 1 ? 'juego' : 'juegos'}` : `${num(cupCount)} vasos · ${num(lidCount)} tapas`,
      detail: cupCount === lidCount ? 'Cada juego incluye 1 vaso y 1 tapa.' : 'Las cantidades no coinciden: revisar vasos y tapas.', kind: 'sauce-container'
    } });
  }
  return result;
}

// Purchase record: ingredient_7, Tetsujin kanikama, 500 g per pack.
export function kanikamaPrepCard(grams, bagGrams = 500) {
  const bags = Math.ceil(grams / bagGrams);
  return {name:'Kanikama · bolsas para preparar',amount:`${num(bags)} ${bags===1?'bolsa':'bolsas'} de ${num(bagGrams)} g`,detail:`Usar ${num(grams)} g en total. Abrir la última bolsa solo según lo necesario.`,kind:'kanikama-bags'};
}

export function preparationCards(batch, run, catalog, format) {
  const orders = ordersInBatch(run, batch.id), context = kanikamaContext(run, catalog);
  const cards = [], seen = new Set();
  for (const item of batch.totals) {
    if (isPackaging(item) || isCoke(item)) continue;
    if (isKingCrab(item) && item.unit === 'g') {
      if (!seen.has('king')) cards.push(kingCrabPrepCard(orders, context.definitions, batch.totals.filter(i => isKingCrab(i) && i.unit === 'g').reduce((sum,i) => sum+i.quantity,0)));
      seen.add('king'); continue;
    }
    if (isKanikama(item)) {
      if (!seen.has('kanikama')) cards.push(kanikamaPrepCard(batch.totals.filter(i => isKanikama(i) && i.unit === 'g').reduce((sum,i)=>sum+i.quantity,0)));
      seen.add('kanikama'); continue;
    }
    if (isShrimp(item) && item.unit === 'g') {
      if (!seen.has('shrimp')) { const shrimp = shrimpForLines(orders.flatMap(o => o.lines), context.definitions); cards.push(shrimpCard(shrimp.count, shrimp.grams)); };
      seen.add('shrimp'); continue;
    }
    if (isSausage(item) && item.unit === 'piece' && (item.packFactor || 1) === 1) {
      cards.push({ name: item.name, amount: `${num(item.quantity)} ${item.quantity === 1 ? 'salchicha entera' : 'salchichas enteras'}`, detail: 'Antes de cortar · cada salchicha se corta en 4 pedazos.', kind: 'sausage-whole' }); continue;
    }
    cards.push(item.presentation || { ...format(item), basis: item.basis, packingNote: item.packingNote });
  }
  const trays = trayPlan(orders);
  return { cards: cards.sort((a, b) => a.name.localeCompare(b.name, 'es')), trays, supplies: preparationSupplies(batch) };
}

export function orderRecipeCards(bag, context, format) {
  const sticks = kanikamaForLines(bag.lines, context), shrimp = shrimpForLines(bag.lines, context.definitions), cards = [];
  let hasSticks = false, hasShrimp = false;
  for (const item of combineSauceContainers(bag.requirements)) {
    const cuts = cutPackingPlan(item, bag.lines, context.definitions);
    if (cuts) cards.push(cuts);
    else if (isKanikama(item)) { if (!hasSticks) cards.push(kanikamaCard(sticks)); hasSticks = true; }
    else if (isShrimp(item) && item.unit === 'g' && shrimp.grams > 0) {
      if (!hasShrimp) cards.push({ name: 'Langostinos', amount: `${num(shrimp.count)} langostinos`, detail: 'Contar piezas para este pedido.', kind: 'shrimp-pieces' });
      hasShrimp = true;
    }
    else cards.push(item.presentation || format(item));
  }
  return cards;
}

// Packing counts are explicit kitchen instructions, not changes to sold weights.
export function packingCountPlan(item, lines, definitions) {
  const potato = /^(papa|patata)s?$/.test(clean(item.name));
  if (!isKanikama(item) && !potato) return null;
  let count = 0;
  for (const line of lines) for (const c of line.components || []) {
    if (c.ingredientId !== item.id) continue;
    if (isKanikama(item) && comboType(line) === 'personal') {
      count += 10 * line.quantity / line.baseQuantity;
    } else {
      const setting = potato ? 'potato_g' : 'kanikama_piece_g';
      const pieces = (c.pieces || []).filter(p => p.setting === setting);
      if (pieces.length) count += pieces.reduce((n,p)=>n+p.count,0);
      else if (item.unit === 'piece') count += c.quantity;
      else if (isKanikama(item)) {
        const result=kanikamaForLines([{...line,components:[c]}],{definitions,gramsPerStick:100/10});
        if(result.unresolved)return null;count+=result.count;
      } else return null;
    }
  }
  if (!(count>0)) return null;
  return {count,amount:`${num(count)} ${potato?(count===1?'papa':'papas'):'piezas de kanikama'}`,detail:potato?'Cantidad de papas antes de cortar; empacar sus pedazos.':'Contar piezas al empacar.',kind:'packing-count'};
}

export function packingQueue(run, mode = 'whole') {
  const groups=run.packingRoutes || [];
  const batches=new Map((run.packingBatches||[]).flatMap((b,index)=>b.orders.map((ref,position)=>[ref,{id:b.id,label:packingBatchHeading(b,b.orders.map(ref=>run.orders.find(o=>o.reference===ref&&!o.cancelled)).filter(Boolean)),rank:index*1000+position,position:position+1}])));
  const ranks=new Map(groups.flatMap((g,index)=>g.orders.map((ref,stop)=>{const trip=routeTrip(g,stop,mode);return [ref,{rank:(trip-1)*10000+index*1000+stop,fulfillment:g.fulfillment,driver:g.driver,trip,stop:stop+1,area:g.area}];})));
  return orderCards(run).map(c=>({...c,batch:batches.get(c.order.reference)||null,route:ranks.get(c.order.reference)||null})).sort((a,b)=>(a.batch?.rank??a.route?.rank??100000)-(b.batch?.rank??b.route?.rank??100000)||a.order.number-b.order.number);
}

export function packingCellSignature(bag, item) {
  return JSON.stringify({quantity:item.quantity,heat:bag.heat,...(bag.sourceBagKeys?{repeatCount:bag.repeatCount,heatCounts:bag.heatCounts}:{}),lines:bag.lines.filter(l=>l.components.some(c=>c.ingredientId===item.id)).map(l=>({name:l.name,quantity:l.quantity,baseQuantity:l.baseQuantity,components:l.components.filter(c=>c.ingredientId===item.id)})),rule:'packing-counts-v1'});
}
export function packingCellChecked(run,bag,item) {
  return (bag.sourceBagKeys?bag.sourceBagKeys.every(key=>!!run.packed[key]):!!run.packed[bag.key]) || run.packingChecklist?.[`${bag.key}:${item.id}`]?.signature === packingCellSignature(bag,item);
}
