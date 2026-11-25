import {bookingCapacity} from './booking-capacity.mjs';
import {readCosting,kitchenCatalog} from './costing/store.mjs';
import { isDeepStrictEqual } from 'node:util';
import { discoverRuns, reconcile, scheduleRun } from './kitchen-sync.mjs';
import { validateCatalog, newRun, addOrder, applyAction, runView, requireValue, KitchenError } from './kitchen-domain.mjs';

export async function getCatalog(db) {
  const central=await readCosting(db);
  if(central)return {version:central.version,document:kitchenCatalog(central.priced,central.version),managed:true};
  return (await db.query('SELECT version, document FROM kitchen_catalog WHERE id=1')).rows[0];
}
export async function saveCatalog(db, input) {
  requireValue(!(await readCosting(db)), 'Edita ingredientes, recetas y precios en Costos y menú. Los cambios se sincronizan automáticamente.',409);
  requireValue(input && Number.isSafeInteger(input.version) && input.version >= 0, 'Falta la versión del menú.');
  const document = validateCatalog(input.document);
  const result = await db.query('UPDATE kitchen_catalog SET document=$1::jsonb, version=version+1, updated_at=now() WHERE id=1 AND version=$2 RETURNING version, document', [JSON.stringify(document), input.version]);
  requireValue(result.rows.length, 'El menú cambió en otra ventana. Actualiza antes de guardar.', 409);
  return result.rows[0];
}
export async function listRuns(db) {
  await discoverRuns(db);
  const ids = (await db.query('SELECT id FROM kitchen_runs ORDER BY delivery_date DESC LIMIT 100')).rows;
  for (const row of ids) await getRun(db,row.id);
  return (await db.query('SELECT id::text, delivery_date::text AS date, version, document FROM kitchen_runs ORDER BY delivery_date DESC LIMIT 100')).rows.map(r => ({ id: r.id, date: r.date, version: r.version, phase: r.document.phase, source:r.document.source, deliveryReservations:r.document.sync?.deliveryReservations, count: r.document.orders.filter(o => !o.cancelled).length, capacity: r.document.capacity, bookingCapacity: r.document.source === 'whatsapp' ? bookingCapacity(r.document.capacity) : r.document.capacity }));
}
export async function createRun(db, input) {
  if (input.startsAt || input.endsAt) { const run = await scheduleRun(db,input); return {version:0,document:runView(run)}; }
  const run = newRun(input);
  try { await db.query('INSERT INTO kitchen_runs (id, delivery_date, document) VALUES ($1,$2,$3::jsonb)', [run.id, run.date, JSON.stringify(run)]); }
  catch (error) { if (error.code === '23505') throw new KitchenError('Ya existe una jornada para esta fecha.', 409); throw error; }
  return { version: 0, document: runView(run) };
}
export async function getRun(db, id, now = new Date()) {
  return db.transaction(async tx => {
    const row = (await tx.query('SELECT version, document FROM kitchen_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
    requireValue(row, 'Jornada no encontrada.', 404);
    const before = structuredClone(row.document);
    await reconcile(tx,row.document,now);
    if (!isDeepStrictEqual(row.document,before)) {
      await tx.query('UPDATE kitchen_runs SET document=$1::jsonb,version=version+1,updated_at=now() WHERE id=$2',[JSON.stringify(row.document),id]);
      row.version++;
    }
    return { version: row.version, document: {...runView(row.document), checkedAt:now.toISOString()} };
  });
}
export async function changeRun(db, id, input, now = new Date()) {
  requireValue(input && Number.isSafeInteger(input.version) && input.version >= 0, 'Falta la versión de la jornada.');
  const result = await db.transaction(async tx => {
    const row = (await tx.query('SELECT version, document FROM kitchen_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
    requireValue(row, 'Jornada no encontrada.', 404);
    const before = structuredClone(row.document);
    await reconcile(tx,row.document,now);
    if (!isDeepStrictEqual(row.document,before)) {
      await tx.query('UPDATE kitchen_runs SET document=$1::jsonb,version=version+1,updated_at=now() WHERE id=$2',[JSON.stringify(row.document),id]);
      row.version++;
    }
    if (row.version !== input.version) return {error:'Los pedidos o cancelaciones cambiaron, posiblemente en otra ventana. Actualiza y revisa las nuevas cantidades antes de continuar.'};
    requireValue(row.version === input.version, 'La jornada cambió en otra ventana. Actualiza antes de guardar; tus cambios aún no se han aplicado.', 409);
    const run = row.document;
    if (run.source === 'whatsapp') {
      requireValue(!['addOrder','cancel'].includes(input.action?.type), 'Los pedidos se crean y cancelan en WhatsApp. No los dupliques en cocina.', 409);
      requireValue(!run.sync.issues.length, 'Hay pedidos de WhatsApp que requieren revisión. Resuelve las incidencias antes de cocinar o empacar.', 409);
      if (input.action?.type === 'start') requireValue(now > new Date(run.freezeAfter), 'Espera al cierre de pedidos y al plazo de cancelación de 12 horas antes de iniciar cocina.', 409);
      requireValue(!run.needsSourceReview || input.action?.type === 'acknowledgeSource', 'Cambió un pedido después de iniciar cocina. Revisa sobrantes y etiquetas, y confirma la revisión.', 409);
    }
    if (input.action?.type === 'acknowledgeSource') {
      requireValue(run.needsSourceReview && typeof input.action.reason === 'string' && input.action.reason.trim().length > 0, 'Registra lo revisado.');
      run.needsSourceReview = false; run.audit.push({...input.action,at:now.toISOString()});
    } else if (input.action?.type === 'addOrder') {
      const catalog = await getCatalog(tx);
      requireValue(catalog.version === input.catalogVersion, 'El menú cambió. Actualiza el precio antes de guardar.', 409);
      const order = addOrder(run, catalog.document, input.action.order, now);
      run.audit.push({ type: 'addOrder', orderId: order.id, at: now.toISOString() });
    } else applyAction(run, input.action, now);
    await tx.query('UPDATE kitchen_runs SET document=$1::jsonb, version=version+1, updated_at=now() WHERE id=$2', [JSON.stringify(run), id]);
    return { version: row.version + 1, document: runView(run) };
  });
  if (result.error) throw new KitchenError(result.error,409);
  return result;
}
