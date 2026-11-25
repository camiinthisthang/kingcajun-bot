import {packingRoutePlan} from './delivery-routes.mjs';
import {usesDeliveryCapacity} from './booking-capacity.mjs';
import {readCosting} from './costing/store.mjs';
import {lineCharge} from './costing/pricing.mjs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { newRun, quoteOrder, validateCatalog, requireValue } from './kitchen-domain.mjs';
const dateOf = value => new Date(new Date(value).getTime() - 5 * 3600000).toISOString().slice(0,10);
const aliases = { 'combo-small':['combo pequeno','pequeno'], 'combo-medium':['combo mediano','mediano'], 'combo-family':['combo familiar','familiar'], 'combo-premium':['combo premium','premium'], 'add-shrimp':['camaron','camarones'], 'add-imitation':['imitacion de cangrejo','imitacion'], 'add-snow':['cangrejo de nieve'], 'add-king':['cangrejo rey','cangrejo real'], 'side-corn':['mazorca','mazorcas'], 'side-potato':['papa','papas'], 'side-sausage':['salchicha','salchichas'], 'side-egg':['huevo','huevos'] };

export async function publishMenu(db, version) {
  requireValue(!(await readCosting(db)), 'El menú se actualiza automáticamente desde Costos y menú.',409);
  return db.transaction(async tx => {
    const row = (await tx.query('SELECT version, document FROM kitchen_catalog WHERE id=1 FOR UPDATE')).rows[0];
    requireValue(row.version === version, 'El menú cambió. Actualiza antes de conectarlo.', 409);
    const catalog = validateCatalog(row.document);
    requireValue(catalog.products.length, 'Configura el menú primero.');
    // Retain old rows and all order references, but stop offering the old menu.
    await tx.query('UPDATE menu_items SET active=FALSE, updated_at=now() WHERE active=TRUE');
    for (const [index, p] of catalog.products.entries()) {
      const ingredients = catalog.ingredients.filter(i => p.components.some(c => c.ingredientId === i.id));
      const combo = p.unit === 'portion';
      const protein = p.id.startsWith('add-') || ingredients.some(i => i.unit === 'g');
      const meta = { product_type: combo ? 'set' : protein ? 'byo_protein' : undefined,
        aliases: [...new Set([p.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(), ...(aliases[p.id] || [])])],
        kitchen: { product: p, ingredients }, upsell_skus: ['KC-KITCHEN-side-corn','KC-KITCHEN-side-potato'] };
      await tx.query(`INSERT INTO menu_items (id,sku,name,description,category,price_cop,active,sort_order,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8::jsonb,now(),now()) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,description=excluded.description,
        category=excluded.category,price_cop=excluded.price_cop,active=TRUE,sort_order=excluded.sort_order,metadata_json=excluded.metadata_json,updated_at=now()`,
      [randomUUID(),`KC-KITCHEN-${p.id}`,p.name,p.description,combo || protein ? 'plate' : 'addon',p.priceCop,index,JSON.stringify(meta)]);
    }
    return { count: catalog.products.length, version };
  });
}

export async function sourceStatus(db) {
  const active = (await db.query(`SELECT count(*)::int AS count FROM menu_items WHERE active=TRUE AND metadata_json ? 'kitchen'`)).rows[0].count;
  const windows = (await db.query(`SELECT id::text,starts_at,ends_at,order_opens_at,order_cutoff_at,capacity,status FROM delivery_windows WHERE ends_at>now() ORDER BY starts_at LIMIT 100`)).rows;
  return { linkedProducts: active, windows };
}

// Discover scheduled dates, including pre-existing WhatsApp delivery windows.
export async function discoverRuns(db) {
  const windows = (await db.query(`SELECT (starts_at AT TIME ZONE 'America/Bogota')::date::text AS date,
      min(order_cutoff_at) AS cutoff, sum(capacity)::int AS capacity FROM delivery_windows
      WHERE (ends_at > now() - interval '7 days' OR id IN (SELECT delivery_window_id FROM orders WHERE status='confirmed'))
      GROUP BY date ORDER BY date`)).rows;
  for (const w of windows) {
    // Existing sales windows may close on the delivery day; preserve their actual cutoff.
    const r = { id: randomUUID(), date:w.date, capacity:w.capacity, cutoff:new Date(w.cutoff).toISOString(), phase:'planning', orders:[], ingredients:[], prep:{}, portions:{}, packed:{}, audit:[], source:'whatsapp' };
    await db.query(`INSERT INTO kitchen_runs (id,delivery_date,document) VALUES ($1,$2,$3::jsonb) ON CONFLICT(delivery_date) DO NOTHING`, [r.id,r.date,JSON.stringify(r)]);
  }
}

export async function scheduleRun(db, input) {
  let run = newRun(input);
  requireValue(/^\d{2}:\d{2}$/.test(input.startsAt || '') && /^\d{2}:\d{2}$/.test(input.endsAt || ''), 'Indica inicio y fin de la franja de entrega.');
  const start = new Date(`${run.date}T${input.startsAt}:00-05:00`), end = new Date(`${run.date}T${input.endsAt}:00-05:00`);
  requireValue(Number.isFinite(+start) && Number.isFinite(+end) && end > start && start > new Date(), 'Franja de entrega inválida o pasada.');
  requireValue(new Date(run.cutoff) <= new Date(+start - 12 * 3600000), 'Cierra pedidos al menos 12 horas antes de la entrega.');
  let opensAt = null;
  if (input.opensAt) {
    requireValue(typeof input.opensAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.opensAt), 'La apertura necesita zona horaria.');
    const opens = new Date(input.opensAt);
    requireValue(Number.isFinite(+opens) && opens < new Date(run.cutoff), 'La apertura debe ser anterior al cierre de pedidos.');
    opensAt = opens.toISOString();
  }
  run.opensAt = opensAt;
  run.source = 'whatsapp';
  await db.transaction(async tx => {
    await tx.query('INSERT INTO delivery_date_limits(delivery_date,capacity) VALUES($1,$2) ON CONFLICT(delivery_date) DO NOTHING',[run.date,run.capacity]);
    const dayLimit=(await tx.query('SELECT capacity FROM delivery_date_limits WHERE delivery_date=$1 FOR UPDATE',[run.date])).rows[0];
    requireValue(dayLimit.capacity===input.capacity,'Las franjas de una misma fecha deben compartir el mismo límite diario.',409);
    requireValue(!(await tx.query(`SELECT id FROM delivery_windows WHERE (starts_at AT TIME ZONE 'America/Bogota')::date=$1 AND starts_at<$3 AND ends_at>$2`,[run.date,start.toISOString(),end.toISOString()])).rowCount,'La franja se cruza con otra de esta fecha.',409);
    const cutoff=run.cutoff;
    const prior=(await tx.query('SELECT document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[run.date])).rows[0];
    if(prior){
      requireValue(prior.document.source==='whatsapp'&&prior.document.phase==='planning','La jornada ya inició o usa pedidos manuales.',409);
      run=prior.document;run.capacity=dayLimit.capacity;run.cutoff=new Date(Math.max(+new Date(run.cutoff),+new Date(cutoff))).toISOString();
      await tx.query('UPDATE kitchen_runs SET document=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1',[run.id,JSON.stringify(run)]);
    }else await tx.query('INSERT INTO kitchen_runs (id,delivery_date,document) VALUES ($1,$2,$3::jsonb)', [run.id,run.date,JSON.stringify(run)]);
    await tx.query(`INSERT INTO delivery_windows (id,fulfillment_type,starts_at,ends_at,order_opens_at,order_cutoff_at,capacity,status,created_at)
      VALUES ($1,'delivery',$2,$3,$4,$5,$6,'open',now())`, [randomUUID(),start.toISOString(),end.toISOString(),opensAt,cutoff,run.capacity]);
  });
  return run;
}

// Call inside the run transaction. Locks source orders so cancellation cannot race
// the final pre-cook check or an individual packing check.
export async function reconcile(tx, run, now = new Date()) {
  const windows = (await tx.query(`SELECT id::text,starts_at,ends_at,order_opens_at,order_cutoff_at,capacity,status FROM delivery_windows
    WHERE (starts_at AT TIME ZONE 'America/Bogota')::date=$1 ORDER BY starts_at FOR UPDATE`, [run.date])).rows;
  if (!windows.length) return;
  run.source = 'whatsapp';
  run.opensAt = windows.every(w => w.order_opens_at) ? new Date(Math.min(...windows.map(w=>+new Date(w.order_opens_at)))).toISOString() : null;
  run.capacity = (await tx.query('SELECT capacity FROM delivery_date_limits WHERE delivery_date=$1',[run.date])).rows[0]?.capacity ?? windows.reduce((s,w) => s+w.capacity,0);
  run.cutoff = new Date(Math.max(...windows.map(w => +new Date(w.order_cutoff_at)))).toISOString();
  run.freezeAfter = new Date(Math.max(+new Date(run.cutoff), ...windows.map(w => +new Date(w.starts_at)-12*3600000))).toISOString();
  run.deliveryWindows = windows;
  const rows = (await tx.query(`SELECT o.*,c.display_name,c.phone_e164,
    (SELECT coalesce(json_agg(json_build_object('count',li.customization_json->>'wholePieceCount','snapshot',li.kitchen_snapshot_json)), '[]'::json)
      FROM order_line_items li WHERE li.order_id=o.id AND li.customization_json->>'wholePiece'='pata_entera'
      AND li.kitchen_snapshot_json->'product'->>'name' ILIKE '%cangrejo rey%') AS king_whole_pieces, EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='confirmed') AS paid, EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.provider='cash_on_delivery') AS cash_on_delivery FROM orders o JOIN customers c ON c.id=o.customer_id
    WHERE o.delivery_window_id=ANY($1::uuid[]) AND COALESCE((o.delivery_coverage->>'posWorkflow')::boolean,FALSE)=FALSE ORDER BY o.created_at,o.id FOR UPDATE OF o`, [windows.map(w => w.id)])).rows;
  run.packingRoutes = await packingRoutePlan(run.date,run.dispatchOverride);
  // Explicit owner-requested previews remain separate from confirmed recipes.
  run.pendingKitchenOrders = rows.filter(o => ['awaiting_payment','payment_review'].includes(o.status) && o.delivery_coverage?.kitchenPreview?.enabled).map(o => ({id:o.id,reference:o.public_id,customer:o.display_name,deliveryWindowId:o.delivery_window_id,address:o.delivery_address,totalCop:o.total_cop,summary:o.delivery_coverage.kitchenPreview.summary,selectionPending:!!o.delivery_coverage.kitchenPreview.selectionPending}));
  const issues = [], priorIssues = run.sync?.issues || [];
  const ready = o => ['confirmed','fulfilled'].includes(o.status) && !o.delivery_coverage?.needsReview && (o.paid || o.cash_on_delivery);
  let changedAfterFreeze = false;
  for (const o of rows) {
    const saved = run.orders.find(x => x.sourceOrderId === o.id);
    const active = ready(o);
    if (o.delivery_coverage?.needsReview && !['cancelled','expired','fulfilled'].includes(o.status)) issues.push({reference:o.public_id,reason:'Entrega por coordinar: '+o.delivery_coverage.label+'. Revisa la cobertura/modalidad con el cliente antes de despachar.'});
    if (saved) {saved.kingCrabWholePieces=o.king_whole_pieces;saved.customerPhone=o.phone_e164; if (/\p{L}/u.test(o.display_name || '')) saved.customer=o.display_name; saved.fulfillmentType=o.fulfillment_type;saved.deliveryCoverage=o.delivery_coverage;saved.deliveryAddress=o.delivery_address;}
    if (['confirmed','fulfilled'].includes(o.status) && !o.paid && !o.cash_on_delivery) issues.push({reference:o.public_id,reason:'Estado confirmado sin un pago confirmado. Revisa el pago antes de cocinar.'});
    // Earlier versions imported COD requests before pickup/delivery was agreed.
    // While still planning, return these to pending instead of counting portions.
    // Keep the prior snapshot in the audit; a later staff approval imports it afresh.
    if (saved && !active && o.delivery_coverage?.needsReview && ['confirmed','awaiting_payment','payment_review'].includes(o.status) && run.phase === 'planning') {
      run.orders = run.orders.filter(x => x.sourceOrderId !== o.id);
      run.audit.push({type:'sourcePending',orderId:o.id,reason:`${o.public_id}: entrega pendiente de aprobación; fuera de cocina confirmada`,previousOrder:saved,at:now.toISOString()});
      continue;
    }
    if (saved) {
      if (!active && !saved.cancelled) {
        saved.cancelled = true; saved.cancellationReason = o.cancellation_reason || `Estado WhatsApp: ${o.status}`;
        saved.cancelledAt = o.cancelled_at || now.toISOString();
        run.audit.push({type:'sourceCancelled',orderId:saved.id,reason:`${o.public_id}: ${saved.cancellationReason}`,at:now.toISOString()});
        if (run.phase !== 'planning') changedAfterFreeze = true;
      } else if (active && saved.cancelled) issues.push({reference:o.public_id,reason:'Un pedido retirado volvió a estar activo. Requiere revisión; no se añade silenciosamente.'});
      continue;
    }
    if (!active) continue;
    if (run.phase !== 'planning') { issues.push({reference:o.public_id,reason:'Confirmación nueva después de iniciar cocina. Requiere revisión de la jornada.'}); continue; }
    try {
      requireValue(!run.orders.some(x => x.reference === o.public_id), 'La referencia ya fue registrada manualmente. Revisa el duplicado antes de cocinar.');
      const lines = (await tx.query(`SELECT kitchen_snapshot_json AS snapshot,quantity,unit_price_cop,line_total_cop FROM order_line_items WHERE order_id=$1 ORDER BY id`,[o.id])).rows;
      requireValue(lines.length && lines.every(l => l.snapshot), 'Pedido sin receta de cocina guardada al vender. No se infieren pesos de nombres o precios.');
      const products = [], ingredients = [], inputs = [], heats = [];
      for (const [index,l] of lines.entries()) {
        const snap = l.snapshot, p = {...snap.product,id:`line-${index}`};
        requireValue(p.priceCop === l.unit_price_cop && l.line_total_cop === lineCharge(l.unit_price_cop,Number(l.quantity)) && Math.abs(snap.quantity - p.baseQuantity*Number(l.quantity)) < 0.000001, 'Precio o cantidad difiere de la receta vendida.');
        products.push(p);
        for (const i of snap.ingredients) {
          const prior = ingredients.find(x => x.id === i.id);
          requireValue(!prior || isDeepStrictEqual(prior,i), 'Ingredientes incompatibles en el pedido.');
          if (!prior) ingredients.push(i);
        }
        const heat = snap.heat || null;
        if (!heats.includes(heat)) heats.push(heat);
        inputs.push({productId:p.id,quantity:snap.quantity,bag:heats.indexOf(heat)+1,heat});
      }
      const c = validateCatalog({products,ingredients});
      const order = quoteOrder(c,{reference:o.public_id,customer:o.display_name || o.phone_e164,notes:o.notes || '',lines:inputs,agreedTotalCop:o.subtotal_cop});
      // Preserve per-sale ingredient definitions without silently mixing revisions.
      for (const i of c.ingredients) { const old=run.ingredients.find(x=>x.id===i.id); requireValue(!old || isDeepStrictEqual(old,i),'La definición del ingrediente cambió entre pedidos. Revisa antes de cocinar.'); }
      for (const i of c.ingredients) if (!run.ingredients.some(x=>x.id===i.id)) run.ingredients.push(i);
      run.orders.push({...order,kingCrabWholePieces:o.king_whole_pieces,customerPhone:o.phone_e164,id:o.id,sourceOrderId:o.id,number:Math.max(0,...run.orders.map(x=>x.number))+1,createdAt:o.created_at,cancelled:false,deliveryAddress:o.delivery_address,deliveryCoverage:o.delivery_coverage,fulfillmentType:o.fulfillment_type,deliveryWindowId:o.delivery_window_id});
      run.audit.push({type:'sourceAdded',orderId:o.id,reason:`${o.public_id} · confirmado en WhatsApp`,at:now.toISOString()});
    } catch (error) { issues.push({reference:o.public_id,reason:error.message}); }
  }
  // Missing source records also fail closed instead of leaving orphan quantities.
  for (const saved of run.orders.filter(o => o.sourceOrderId && !o.cancelled)) if (!rows.some(o=>o.id===saved.sourceOrderId)) issues.push({reference:saved.reference,reason:'Pedido de origen no encontrado en esta fecha. Revisa antes de cocinar.'});
  if (changedAfterFreeze) {
    run.audit.push({type:'sourceReview',reason:'Cambio posterior al cierre: se invalidaron las comprobaciones de bolsas. Revisa sobrantes y etiquetas.',previousPacked:structuredClone(run.packed),at:now.toISOString()});
    run.packed = {}; run.needsSourceReview = true;
    if (run.phase === 'complete') run.phase = 'cooking';
  }
  const deliveryReservations=rows.filter(o=>usesDeliveryCapacity(o)&&(['confirmed','fulfilled','payment_review'].includes(o.status)||(o.status==='awaiting_payment'&&new Date(o.payment_expires_at)>now))).length;
  const summary = { deliveryReservations, confirmed:rows.filter(ready).length, cancelled:rows.filter(o=>o.status==='cancelled').length, cancelledRefs:rows.filter(o=>o.status==='cancelled').map(o=>o.public_id),
    pending:rows.filter(o=>['awaiting_payment','payment_review','confirmed'].includes(o.status)&&!ready(o)).length,
    refundPending:rows.filter(o=>o.refund_status==='pending').map(o=>o.public_id), issues };
  if (!isDeepStrictEqual(priorIssues,issues)) run.audit.push({type:'sourceIssues',reason:issues.length ? `${issues.length} pedidos requieren revisión` : 'Sin incidencias de sincronización',at:now.toISOString()});
  // Timestamp is response metadata; unchanged checks don't invalidate open forms.
  run.sync = summary;
}
