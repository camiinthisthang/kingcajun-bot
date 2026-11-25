import {servicePeriods} from '../public/service-periods.js';
import {isShrimp, shrimpForLines, packingCountPlan, packingCellSignature, packingSections, isPackingSupply} from '../public/kitchen-presentation.js';
import {bookingCapacity,usesDeliveryCapacity} from './booking-capacity.mjs';
import {lineCharge} from './costing/pricing.mjs';
import { isDeepStrictEqual } from 'node:util';
// Recipe quantities support fractions; customer charges remain integer COP.
// This module never changes customer orders, payment records, or their prices.
import { randomUUID } from 'node:crypto';

export class KitchenError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const requireValue = (ok, message, status) => { if (!ok) throw new KitchenError(message, status); };
const quantity = (v, min = 0.000001, max = 100000000) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v, min = 1, max = 100000000) => Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v, max = 120) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const id = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
export function validateDate(value) {
  const parsed = new Date(`${value}T12:00:00Z`);
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'Fecha inválida.');
  return value;
}
export function validateCatalog(input) {
  requireValue(input && Array.isArray(input.ingredients) && Array.isArray(input.products) && input.ingredients.length <= 100 && input.products.length <= 200, 'Menú inválido.');
  const ingredients = input.ingredients.map(i => {
    requireValue(i && id(i.id) && text(i.name) && ['g', 'ml', 'piece'].includes(i.unit) && text(i.basis, 200), 'Cada ingrediente necesita nombre, unidad y estado de pesaje.');
    requireValue(i.unit === 'piece' || ['portion', 'batch'].includes(i.method), 'Elige cómo registrar el peso: por porción o por lote.');
    const packFactor = i.packFactor ?? 1;
    requireValue(integer(packFactor, 1, 100) && (i.unit === 'piece' || packFactor === 1), 'El número de cortes debe ser entero y solo aplica a piezas.');
    requireValue(typeof (i.packLabel ?? '') === 'string' && (i.packLabel ?? '').length <= 120, 'Nombre de la pieza empacada inválido.');
    requireValue(typeof (i.packingNote ?? '') === 'string' && (i.packingNote ?? '').length <= 500, 'Nota de empaque demasiado larga.');
    const screening = i.screening ?? null;
    requireValue(!screening || (i.unit === 'piece' && packFactor === 1 && integer(screening.minGrams) && integer(screening.maxGrams) && screening.maxGrams >= screening.minGrams), 'Rango de selección por pieza inválido.');
    return { id: i.id, name: i.name.trim(), unit: i.unit, basis: i.basis.trim(), method: i.unit === 'piece' ? 'count' : i.method, packFactor, packLabel: (i.packLabel ?? '').trim(), packingNote: (i.packingNote ?? '').trim(), screening: screening ? { minGrams: screening.minGrams, maxGrams: screening.maxGrams } : null };
  });
  const ids = new Set(ingredients.map(i => i.id));
  requireValue(ids.size === ingredients.length, 'Hay ingredientes duplicados.');
  const products = input.products.map(p => {
    requireValue(p && id(p.id) && text(p.name) && ['g', 'piece', 'portion'].includes(p.unit) && integer(p.baseQuantity) && integer(p.priceCop, 0, 2000000000), 'Producto o precio inválido.');
    requireValue(Array.isArray(p.components) && p.components.length > 0 && p.components.length <= 50, 'Define los ingredientes de cada producto.');
    const components = p.components.map(c => {
      requireValue(c && ids.has(c.ingredientId) && quantity(c.quantity), 'Ingrediente o cantidad inválida en la receta.');
      return { ingredientId: c.ingredientId, quantity: c.quantity, ...(c.displayText ? {displayText:c.displayText,pieces:c.pieces??[]} : {}) };
    });
    requireValue(new Set(components.map(c => c.ingredientId)).size === components.length, 'Combina los ingredientes repetidos en una sola fila.');
    requireValue(p.requiresHeat === undefined || typeof p.requiresHeat === 'boolean', 'Regla de picante inválida.');
    requireValue(p.includesSauce === undefined || typeof p.includesSauce === 'boolean', 'Regla de salsa inválida.');
    requireValue(typeof (p.description ?? '') === 'string' && (p.description ?? '').length <= 500, 'Descripción demasiado larga.');
    return { sauceOz:p.sauceOz??null,menuVersion:p.menuVersion??null,id: p.id, name: p.name.trim(), unit: p.unit, baseQuantity: p.baseQuantity, priceCop: p.priceCop, components, requiresHeat: p.requiresHeat ?? false, includesSauce: p.includesSauce ?? false, description: (p.description ?? '').trim() };
  });
  requireValue(new Set(products.map(p => p.id)).size === products.length, 'Hay productos duplicados.');
  return { ingredients, products };
}
export function newRun(input) {
  requireValue(input && typeof input === 'object', 'Jornada inválida.');
  const date = validateDate(input.date);
  requireValue(integer(input.capacity, 1, 200), 'El límite debe estar entre 1 y 200 pedidos.');
  requireValue(typeof input.cutoff === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.cutoff), 'El cierre necesita fecha, hora y zona horaria.');
  const cutoff = new Date(input.cutoff);
  requireValue(Number.isFinite(cutoff.getTime()) && cutoff < new Date(`${date}T${input.startsAt || '00:00'}:00-05:00`), 'El cierre de pedidos debe ser anterior a la entrega.');
  return { id: randomUUID(), date, capacity: input.capacity, cutoff: cutoff.toISOString(), phase: 'planning', orders: [], ingredients: [], prep: {}, portions: {}, packed: {}, audit: [] };
}
const activeOrders = run => run.orders.filter(o => !o.cancelled);
export function quoteOrder(catalog, input, preview=false) {
  requireValue(input && text(input.reference, 80) && text(input.customer) && Array.isArray(input.lines) && input.lines.length > 0 && input.lines.length <= 100, 'Completa referencia, cliente y productos.');
  requireValue(typeof (input.notes ?? '') === 'string' && (input.notes ?? '').length <= 1000, 'Notas demasiado largas.');
  const lines = input.lines.map(l => {
    requireValue(l && typeof l === 'object', 'Línea de pedido inválida.');
    const p = catalog.products.find(p => p.id === l.productId);
    requireValue(p && quantity(l.quantity) && integer(l.bag, 1, 100), 'Producto, cantidad o bolsa inválidos.');
    requireValue(p.unit==='g'||Number.isSafeInteger(l.quantity/p.baseQuantity),'Pide unidades enteras de este producto.');
    requireValue(!p.requiresHeat || ['Suave', 'Medio'].includes(l.heat), `Elige picante Suave o Medio para ${p.name}.`);
    const priceCop = lineCharge(p.priceCop,l.quantity,p.baseQuantity);
    requireValue(integer(priceCop, 0, 2000000000), 'El precio supera el límite admitido.');
    const components = p.components.map(c => {
      const scaled = Number((c.quantity*l.quantity/p.baseQuantity).toFixed(9));
      requireValue(quantity(scaled), 'Cantidad de ingrediente fuera de rango.');
      return { ...c, quantity: scaled, pieces:c.pieces?.map(piece=>({...piece,count:piece.count*l.quantity/p.baseQuantity})) };
    });
    return { sauceOz:p.sauceOz===null?null:p.sauceOz*l.quantity/p.baseQuantity,menuVersion:p.menuVersion??null,productId: p.id, name: p.name, unit: p.unit, quantity: l.quantity, baseQuantity: p.baseQuantity, unitPriceCop: p.priceCop, priceCop, bag: l.bag, components, heat: p.requiresHeat ? l.heat : null, includesSauce: p.includesSauce ?? false };
  });
  for (const bag of new Set(lines.map(l => l.bag))) requireValue(new Set(lines.filter(l => l.bag === bag && l.heat).map(l => l.heat)).size <= 1, 'Una bolsa no puede mezclar picante Suave y Medio. Usa bolsas distintas.');
  const totalCop = lines.reduce((sum, l) => sum + l.priceCop, 0);
  requireValue(integer(totalCop, 0, 2000000000), 'Total fuera de rango.');
  if(!preview)requireValue(integer(input.agreedTotalCop, 0, 2000000000), 'Registra el total de comida acordado con el cliente.');
  if(!preview)requireValue(totalCop === input.agreedTotalCop, `El cálculo (${totalCop} COP) no coincide con el precio de comida acordado (${input.agreedTotalCop} COP). Revisa el pedido y el menú.`);
  return { reference: input.reference.trim(), customer: input.customer.trim(), notes: (input.notes ?? '').trim(), lines, totalCop, agreedTotalCop: input.agreedTotalCop };
}
export function addOrder(run, catalog, input, now = new Date()) {
  requireValue(run.phase === 'planning', 'La cocina ya comenzó. Los pedidos están congelados.', 409);
  requireValue(now < new Date(run.cutoff), 'El cierre de pedidos ya pasó.', 409);
  requireValue(activeOrders(run).length < run.capacity, 'Se alcanzó el límite de pedidos.', 409);
  const order = quoteOrder(catalog, input);
  requireValue(!run.orders.some(o => o.reference.toLowerCase() === order.reference.toLowerCase()), 'Esta referencia ya existe en la jornada.', 409);
  const usedIds = new Set(order.lines.flatMap(l => l.components.map(c => c.ingredientId)));
  for (const ingredientId of usedIds) {
    const ingredient = catalog.ingredients.find(i => i.id === ingredientId);
    const saved = run.ingredients.find(i => i.id === ingredientId);
    requireValue(!saved || isDeepStrictEqual(saved,ingredient), 'Un ingrediente cambió después de recibir pedidos. Usa un ingrediente nuevo para otra preparación.', 409);
    if (!saved) run.ingredients.push(structuredClone(ingredient));
  }
  const saved = { ...order, id: randomUUID(), number: run.orders.length + 1, createdAt: now.toISOString(), cancelled: false };
  run.orders.push(saved);
  return saved;
}
export function bagsFor(run) {
  return activeOrders(run).flatMap(order => [...new Set(order.lines.map(l => l.bag))].sort((a, b) => a - b).map(bag => {
    const lines = order.lines.filter(l => l.bag === bag);
    const amounts = new Map();
    for (const c of lines.flatMap(l => l.components)) {
      const entry=amounts.get(c.ingredientId)??{quantity:0,pieces:[]};entry.quantity+=c.quantity;
      for(const p of c.pieces??[]){const old=entry.pieces.find(x=>x.setting===p.setting);if(old)old.count+=p.count;else entry.pieces.push({...p});}
      amounts.set(c.ingredientId,entry);
    }
    return { key: `${order.id}:${bag}`, orderId: order.id, number: bag, orderNumber: order.number, reference: order.reference, customer: order.customer, notes: order.notes, totalCop: order.totalCop, lines, heat: lines.find(l => l.heat)?.heat ?? null, includesSauce: lines.some(l => l.includesSauce),
      requirements: [...amounts].map(([ingredientId, values]) => ({ ingredientId, ...values })) };
  }));
}
export function totalsFor(run) {
  const amounts = new Map();
  for (const c of bagsFor(run).flatMap(b => b.requirements)) amounts.set(c.ingredientId, (amounts.get(c.ingredientId) ?? 0) + c.quantity);
  return [...amounts].map(([id, quantity]) => ({ ...run.ingredients.find(i => i.id === id), quantity }));
}
// Summarize the recipes saved with the orders, independently of today's catalog.
// Keep delivery windows separate and never assign an unscheduled order to one.
export function preparationFor(run) {
  const orders = activeOrders(run);
  const windows = [...(run.deliveryWindows ?? [])].filter(w => w.status !== 'closed' || orders.some(o => o.deliveryWindowId === w.id)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const known = new Set(windows.map(w => w.id));
  const groups = [
    ...servicePeriods(windows).map(period => ({ ...period, orders: orders.filter(o => period.windowIds.includes(o.deliveryWindowId)) })),
    ...(windows.length && orders.some(o => !known.has(o.deliveryWindowId)) ? [{ id: 'unassigned', orders: orders.filter(o => !known.has(o.deliveryWindowId)) }] : []),
    { id: 'all', orders }
  ];
  return groups.map(({ orders: group, ...batch }) => {
    const amounts = new Map();
    for (const {component, line} of group.flatMap(o => o.lines.flatMap(line => line.components.map(component => ({component, line}))))) {
      const row = amounts.get(component.ingredientId) ?? { ...run.ingredients.find(i => i.id === component.ingredientId), quantity: 0, pieces: [], weightOnlyQuantity: 0 };
      row.quantity += component.quantity;
      // Legacy whole-cluster orders retain a weight for pricing, but must be
      // prepared as whole pieces. Never convert arbitrary gram portions.
      let pieces = component.pieces ?? [];
      if (!pieces.length && /cangrejo de nieve/i.test(row.name || '') && /racimo entero/i.test(line.name || '')) {
        const count = line.wholePieceCount ?? (line.unit === 'piece' ? line.quantity : /racimo entero solo/i.test(line.name) ? 1 : null);
        if (Number.isFinite(count) && count > 0) pieces = [{setting:'snow_cluster_g', label:'racimo(s) de cangrejo de nieve', count}];
      }
      if (!pieces.length) row.weightOnlyQuantity += component.quantity;
      for (const piece of pieces) {
        const previous = row.pieces.find(p => p.setting === piece.setting && p.label === piece.label);
        if (previous) previous.count += piece.count;
        else row.pieces.push({ ...piece });
      }
      amounts.set(component.ingredientId, row);
    }
    const bags = bagsFor({ ...run, orders: group });
    return { ...batch, orderCount: group.length, bagCount: bags.length,
      packedCount: bags.filter(b => run.packed[b.key]).length,
      totals: [...amounts.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      sauces: ['Suave', 'Medio', null].map(heat => ({ heat, bags: bags.filter(b => b.includesSauce && b.heat === heat).length,
        ounces: bags.filter(b => b.includesSauce && b.heat === heat).reduce((sum, b) => sum + b.lines.reduce((s, l) => s + (l.sauceOz ?? 0), 0), 0)
      })).filter(s => s.bags) };
  });
}
// Largest-remainder allocation preserves the batch total at 1 g resolution.
// Unallocated raw input is retained as a separate surplus share.
export function targetsFor(run, ingredientId) {
  const prep = run.prep[ingredientId];
  requireValue(prep && quantity(prep.raw) && integer(prep.cooked), 'Registra primero los pesos del lote.');
  const requirements = bagsFor(run).flatMap(b => b.requirements.filter(r => r.ingredientId === ingredientId).map(r => ({ key: b.key, raw: r.quantity })));
  const needed = requirements.reduce((sum, r) => sum + r.raw, 0);
  requireValue(prep.raw >= needed, 'El lote tiene menos peso inicial que el prometido.');
  const allocation = [...requirements, { key: 'surplus', raw: prep.raw - needed }].map(r => {
    const product = BigInt(prep.cooked) * BigInt(Math.round(r.raw*1000000));
    return { ...r, grams: Number(product / BigInt(Math.round(prep.raw*1000000))), remainder: product % BigInt(Math.round(prep.raw*1000000)) };
  });
  let remaining = prep.cooked - allocation.reduce((sum, r) => sum + r.grams, 0);
  const ranking = [...allocation].sort((a, b) => a.remainder === b.remainder ? a.key.localeCompare(b.key) : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranking) { if (remaining-- > 0) row.grams += 1; }
  return Object.fromEntries(allocation.map(r => [r.key, r.grams]));
}
export function runView(run) {
  const bags = bagsFor(run).map(b => ({ ...b, packed: run.packed[b.key] ?? null,
    requirements: b.requirements.map(r => {
      const ingredient = run.ingredients.find(i => i.id === r.ingredientId);
      const target = ingredient.method === 'batch' && run.prep[ingredient.id] ? targetsFor(run, ingredient.id)[b.key] : null;
      return { ...r, ...ingredient, target, packQuantity: ingredient.unit === 'piece' ? r.quantity * (ingredient.packFactor ?? 1) : null, portion: run.portions[`${b.key}:${ingredient.id}`] ?? null };
    }) }));
  return { ...run, bookingCapacity: run.source === 'whatsapp' ? bookingCapacity(run.capacity) : run.capacity, bags, preparation: preparationFor(run), totals: totalsFor(run).map(i => ({ ...i, prep: run.prep[i.id] ?? null, surplus: i.method === 'batch' && run.prep[i.id] ? targetsFor(run, i.id).surplus : null })), orderCount: activeOrders(run).length, deliveryOrderCount:activeOrders(run).filter(usesDeliveryCapacity).length, pickupOrderCount:activeOrders(run).filter(o=>!usesDeliveryCapacity(o)).length, totalCop: activeOrders(run).reduce((s, o) => s + o.totalCop, 0) };
}
export function applyAction(run, action, now = new Date()) {
  requireValue(action && typeof action.type === 'string', 'Acción inválida.');
  requireValue(run.phase !== 'complete', 'Esta jornada ya terminó.', 409);
  if (action.type === 'packingCheck') {
    const bags=runView(run).bags;
    const bag=bags.find(b=>b.key===action.bagKey) || packingSections(bags).find(b=>b.key===action.bagKey);
    requireValue(bag && !bag.packed,'Pedido no disponible para cambiar su lista de empaque.');
    const item=bag.requirements.find(i=>i.id===action.ingredientId);
    requireValue(item && typeof action.checked === 'boolean','Ingrediente inválido.');
    requireValue(action.signature===packingCellSignature(bag,item),'El pedido cambió. Actualiza antes de marcar el ingrediente.',409);
    run.packingChecklist ||= {};
    const key=`${bag.key}:${item.id}`;
    if(action.checked)run.packingChecklist[key]={signature:action.signature,at:now.toISOString()};else delete run.packingChecklist[key];
  } else if (action.type === 'cancel') {
    requireValue(run.phase === 'planning', 'No se puede cancelar después de empezar a cocinar.', 409);
    const order = run.orders.find(o => o.id === action.orderId);
    requireValue(order && !order.cancelled, 'Pedido no encontrado.', 404);
    requireValue(text(action.reason, 500), 'Registra el motivo de cancelación.');
    order.cancelled = true; order.cancellationReason = action.reason.trim();
  } else if (action.type === 'start') {
    requireValue(run.phase === 'planning' && activeOrders(run).length > 0, 'Añade pedidos antes de empezar.');
    run.phase = 'cooking';
  } else if (action.type === 'prep') {
    requireValue(run.phase === 'cooking', 'Primero inicia la cocina.');
    const ingredient = totalsFor(run).find(i => i.id === action.ingredientId);
    requireValue(ingredient && ingredient.method !== 'portion', 'Ingrediente no preparado por lote.');
    requireValue(!Object.keys(run.packed).length, 'Ya hay bolsas empacadas. Reabre las bolsas antes de cambiar el lote.', 409);
    let raw = action.raw, screening = null;
    if (ingredient.screening) {
      requireValue(Array.isArray(action.pieceWeights) && action.pieceWeights.length > 0 && action.pieceWeights.length <= 1000 && action.pieceWeights.every(w => integer(w)), 'Registra el peso inicial en gramos de cada pieza que revisaste.');
      const { minGrams, maxGrams } = ingredient.screening;
      const accepted = action.pieceWeights.filter(w => w >= minGrams && w <= maxGrams);
      const setAside = action.pieceWeights.filter(w => w < minGrams || w > maxGrams);
      raw = accepted.length;
      screening = { accepted, setAside, minGrams, maxGrams };
      requireValue(raw >= ingredient.quantity, `Solo ${raw} piezas cumplen el rango ${minGrams}–${maxGrams} g; necesitas ${ingredient.quantity}. Aparta las piezas fuera de rango y revisa más.`);
    }
    requireValue(quantity(raw) && raw >= ingredient.quantity, 'La cantidad inicial es menor que la prometida.');
    if (ingredient.method === 'batch') requireValue(integer(action.cooked), 'Registra el peso cocido neto, sin salsa ni empaque.');
    run.prep[ingredient.id] = { raw, cooked: ingredient.method === 'batch' ? action.cooked : null, screening, at: now.toISOString() };
  } else if (action.type === 'portion') {
    requireValue(run.phase === 'cooking', 'Primero inicia la cocina.');
    const bag = bagsFor(run).find(b => b.key === action.bagKey);
    const req = bag?.requirements.find(r => r.ingredientId === action.ingredientId);
    const ingredient = run.ingredients.find(i => i.id === action.ingredientId);
    requireValue(req && ingredient?.method === 'portion', 'Porción no encontrada.');
    requireValue(!run.packed[bag.key], 'Reabre la bolsa antes de cambiar la porción.', 409);
    const shrimpCount = isShrimp(ingredient) ? shrimpForLines(bag.lines, run.ingredients).count : null;
    if (shrimpCount !== null) requireValue(Number.isInteger(action.countedPieces) && action.countedPieces === shrimpCount, `Cuenta exactamente ${shrimpCount} langostinos para esta porción.`);
    else requireValue(quantity(action.raw) && action.raw === req.quantity, `La porción debe medir ${req.quantity} ${ingredient.unit} antes de cocinar.`);
    requireValue(action.identified === true, 'Confirma que la porción está identificada para esta bolsa.');
    run.portions[`${bag.key}:${ingredient.id}`] = shrimpCount !== null ? { countedPieces: action.countedPieces, countBasis: '7-per-100g-rounded-per-portion', identified: true, at: now.toISOString() } : { raw: action.raw, identified: true, at: now.toISOString() };
  } else if (action.type === 'pack') {
    requireValue(run.phase === 'cooking', 'Primero inicia la cocina.');
    const bag = runView(run).bags.find(b => b.key === action.bagKey);
    requireValue(bag, 'Bolsa no encontrada.', 404);
    requireValue(!run.packed[bag.key], 'Esta bolsa ya está empacada.', 409);
    requireValue(action.labelChecked === true, 'Comprueba la referencia y el número en la etiqueta.');
    requireValue(!bag.includesSauce || action.sauceChecked === true, 'Confirma la salsa de la casa incluida.');
    requireValue(!bag.heat || action.heatChecked === true, `Comprueba el picante ${bag.heat}.`);
    const requirements = action.foodOnly === true ? bag.requirements.filter(i=>!isPackingSupply(i)) : bag.requirements;
    requireValue(Array.isArray(action.checks) && action.checks.length === requirements.length && new Set(action.checks.map(c => c.ingredientId)).size === action.checks.length, 'Comprueba todos los ingredientes una sola vez.');
    const checked = requirements.map(r => {
      const c = action.checks.find(c => c.ingredientId === r.ingredientId);
      requireValue(c && c.confirmed === true, `Falta comprobar ${r.name}.`);
      const countPlan = packingCountPlan(r, bag.lines, run.ingredients);
      if (countPlan) requireValue(c.countedPieces === countPlan.count, `Cuenta ${countPlan.amount} para este pedido.`);
      else if (r.method === 'portion' && isShrimp(r)) requireValue(r.portion?.identified && r.portion?.countedPieces === shrimpForLines(bag.lines, run.ingredients).count, 'Falta contar e identificar los langostinos.');
      else if (r.method === 'portion') requireValue(r.portion?.raw === r.quantity, `Falta pesar e identificar la porción de ${r.name}.`);
      else {
        requireValue(run.prep[r.id], `Falta preparar ${r.name}.`);
        const target = r.unit === 'piece' ? r.packQuantity : r.target;
        requireValue(quantity(target) && quantity(c.actual) && c.actual === target, `Empaca exactamente ${target ?? 'pendiente'} ${r.unit === 'piece' ? 'piezas' : 'g'} de ${r.name}.`);
      }
      return { ingredientId: r.id, ...(countPlan ? {countedPieces:c.countedPieces,countBasis:'packing-pieces-v1'} : {}), actual: r.method === 'portion' ? null : c.actual, target: r.method === 'portion' ? null : r.unit === 'piece' ? r.packQuantity : r.target, confirmed: true };
    });
    run.packed[bag.key] = { ...(action.foodOnly === true ? {scope:'food'} : {}), checks: checked, labelChecked: true, sauceChecked: bag.includesSauce ? true : null, heatChecked: bag.heat ? true : null, at: now.toISOString() };
  } else if (action.type === 'reopen') {
    requireValue(run.packed[action.bagKey], 'La bolsa no está empacada.');
    requireValue(text(action.reason, 500), 'Registra por qué reabres la bolsa.');
    delete run.packed[action.bagKey];
  } else if (action.type === 'complete') {
    const bags = bagsFor(run);
    requireValue(run.phase === 'cooking' && bags.length > 0 && bags.every(b => run.packed[b.key]), 'Completa todas las bolsas antes de cerrar.');
    run.phase = 'complete';
  } else throw new KitchenError('Acción desconocida.');
  run.audit.push({ ...structuredClone(action), at: now.toISOString() });
  return run;
}
