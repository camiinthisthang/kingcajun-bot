import {kitchenPhones,kitchenName,matchesKitchenOrder,packingCustomerName} from './kitchen-search.js?v=batch-names-20261024';
import { recipeQuantity, preparationQuantity } from './kitchen-quantities.js?v=whole-clusters-20261018';
import { kitchenDate, packingProgress, packingSections, packingProductSummary, preparationCards, kanikamaContext, kanikamaForLines, orderRecipeCards, ordersInBatch, trayPlan, orderCards, comboType, cutPackingPlan, packingActual, packingCountPlan, packingQueue, packingCellSignature, packingCellChecked, isPackingSupply, isCorn, isSausage, isShrimp, shrimpForLines } from './kitchen-presentation.js?v=per-combo-20261025';
const $ = s => document.querySelector(s);
const money = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unit = u => ({ g: 'g', ml:'ml', piece: 'piezas', portion: 'porciones' })[u];
const phases = { planning: 'Recibiendo pedidos', cooking: 'En cocina', complete: 'Lista para entrega' };
const packLabel = i => i.packLabel || 'piezas';
const methodName = m => ({ portion: 'Porción identificada', batch: 'Lote pesado', count: 'Conteo' })[m];
let source = {linkedProducts:0,windows:[]};
let packMode = 'batch', packRoute = null;
const dispatchMode = () => 'saved';
const packRouteKey = c => c.batch ? 'batch:'+c.batch.id : c.route?.fulfillment==='hq_walk'?'hq_walk':c.route ? `${c.route.driver}:${c.route.trip}` : (['pickup','own_courier'].includes(c.order?.deliveryCoverage?.method||c.order?.fulfillmentType)?'pickup':'unassigned');
const trayItem = i => /bandeja|caja/i.test(i.name);
function orderedColumns(group){return group;}
let catalog = { version: 0, document: { ingredients: [], products: [] } }, runs = [], selected = null, actionHandler, busy = false, activePackOrderId = null;
let packSearchQuery = "";
let runRequestVersion = 0, changingRun = false, refreshing = false;
let prepRunId = null, prepBatchId = null;
const blank = '<div class="empty"><h2>Elige una jornada</h2><p>Crea o selecciona una fecha de entrega para empezar.</p></div>';
const msg = (value, error = false) => { $('#message').textContent = value; $('#message').className = error ? 'error' : ''; };
async function api(path, body, method = 'POST') {
  const response = await fetch(`/api/kitchen/${path}`, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 401) throw new Error('Tu sesión terminó. Abre Administración e inicia sesión; conserva esta ventana para recuperar el borrador.');
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'No se pudo completar la acción.');
  return value.data;
}
function openDialog(id) { const dialog = $(id); dialog.querySelector('.form-error').textContent = ''; dialog.showModal(); }
function bindForm(id, handler) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const form = event.currentTarget, submit = form.querySelector('[type=submit]');
    form.querySelector('.form-error').textContent = ''; submit.disabled = true;
    try { await handler(new FormData(form), form); }
    catch (error) { form.querySelector('.form-error').textContent = error.message; }
    finally { busy = false; submit.disabled = false; }
  });
}
async function refresh({force = false} = {}) {
  if (refreshing || busy || changingRun || document.querySelector('dialog[open]')) return;
  if (!force && (document.activeElement?.id === 'pack-search' || document.activeElement?.id === 'run-select' || document.activeElement?.matches('[data-service-period], #prep-batch') || document.activeElement?.closest('#rider-count-form'))) return;
  refreshing = true;
  const request = ++runRequestVersion;
  const runId = selected?.document.id || $('#run-select').value;
  try {
    const [nextCatalog, nextRuns, nextSource] = await Promise.all([api('catalog'), api('runs'), api('source')]);
    if (request !== runRequestVersion) return;
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Bogota'});
    const chosen = runId || [...nextRuns].filter(r => r.date >= today && r.phase !== 'complete').sort((a,b)=>a.date.localeCompare(b.date))[0]?.id || nextRuns[0]?.id;
    const nextSelected = chosen ? await api(`runs/${chosen}`) : null;
    if (request !== runRequestVersion || busy || changingRun) return;
    catalog=nextCatalog; runs=nextRuns; source=nextSource; selected=nextSelected;
    render(); msg(selected?.document.source === 'whatsapp' ? 'Pedidos y cancelaciones comprobados con WhatsApp. Actualización automática cada 15 segundos mientras esta ventana está activa.' : 'Datos actualizados. Programa una entrega para recibir los pedidos de WhatsApp.');
  } catch (error) { if(request===runRequestVersion)msg(error.message, true); }
  finally { refreshing = false; }
}
async function selectKitchenRun(id) {
  const request=++runRequestVersion;
  changingRun=true;
  try {
    const next=id?await api(`runs/${id}`):null;
    if(request!==runRequestVersion)return;
    selected=next;packRoute=null;packMode='batch';activePackOrderId=null;packSearchQuery='';render();
  } catch(error) { if(request===runRequestVersion){$('#run-select').value=selected?.document.id||'';msg(error.message,true);} }
  finally { if(request===runRequestVersion)changingRun=false; }
}

function render() {
  $('#run-select').innerHTML = '<option value="">Selecciona una fecha</option>' + runs.map(r => `<option value="${r.id}" ${r.id === selected?.document.id ? 'selected' : ''}>${esc(kitchenDate(r.date))}</option>`).join('');
  $('#save-state').textContent = selected ? `${phases[selected.document.phase]} · ${selected.document.orderCount} pedidos · Guardado` : 'Sin jornada seleccionada';
  renderPreparation(); renderComboOverview(); renderOrders(); renderDay(); renderCook(); renderPack(); renderMenu();
}
function renderComboOverview() {
  const r = selected?.document, container = $('#combo-overview');
  container.hidden = !r;
  if (!r) { container.innerHTML = ''; return; }
  const orders = ordersInBatch(r, prepBatchId || 'all'), { combos, customOrders } = trayPlan(orders);
  const periodLabel = batchLabel(r.preparation?.find(b => b.id === prepBatchId) || {id:'all'});
  const total = Object.values(combos).reduce((sum, count) => sum + count, 0);
  const count = value => new Intl.NumberFormat('es-CO').format(value);
  container.innerHTML = `<div class="card combo-overview">${periodControls(r, 'combo-period')}<div class="combo-overview-heading"><div><p class="eyebrow">${esc(kitchenDate(r.date))} · ${esc(periodLabel)}${r.source === 'cooking-test' ? ' · PRUEBA DE COCINA' : ''}</p><h2>Combos por horario</h2></div><span class="pill">${count(total)} combos · ${orders.length} pedidos</span></div>
  <dl class="combo-overview-grid">${[['personal', 'Personal'], ['mediano', 'Mediano'], ['familiar', 'Familiar'], ['premium', 'Premium']].map(([type, name]) => `<div><dt>${name}</dt><dd>${count(combos[type])}</dd><small>${combos[type] === 1 ? 'combo' : 'combos'}</small></div>`).join('')}<div class="combo-custom"><dt>Personalizados</dt><dd>${customOrders.length}</dd><small>${customOrders.length === 1 ? 'pedido sin combo' : 'pedidos sin combo'}</small></div></dl>
  <p class="combo-overview-note">Contamos cada combo: un pedido con 3 personales suma 3. Los combos con adicionales siguen contando como combos. Solo incluye pedidos para preparar.</p></div>`;
}
function sourceStatus(r) {
  let content = r.source === 'whatsapp' ? `<div class="notice ${r.sync?.issues.length || r.needsSourceReview ? 'warning' : ''}"><strong>WhatsApp · ${r.sync?.confirmed || 0} confirmados · ${r.sync?.cancelled || 0} cancelados · ${r.sync?.pending || 0} pendientes de pago / revisión</strong><p>Última comprobación: ${esc(new Date(r.checkedAt || Date.now()).toLocaleTimeString('es-CO', {timeZone:'America/Bogota'}))}. Cancelaciones hasta 12 horas antes del inicio de cada franja.</p>${(r.sync?.issues || []).map(i=>`<p>${esc(i.reference)}: ${esc(i.reason)}</p>`).join('')}${r.needsSourceReview ? '<p>Cambió un pedido después de iniciar cocina. Se retiraron sus cantidades y se reabrieron los grupos. Revisa sobrantes y etiquetas.</p><button data-command="acknowledgeSource">Registrar revisión</button>' : ''}${r.sync?.cancelledRefs?.length ? `<p>Cancelados: ${r.sync.cancelledRefs.map(esc).join(', ')}. No se incluyen en preparación.</p>` : ''}${r.sync?.refundPending?.length ? `<p>Reembolso pendiente de gestión: ${r.sync.refundPending.map(esc).join(', ')}.</p>` : ''}</div>` : '<div class="notice">Programa tus fechas de entrega y conecta el menú en Menú y recetas. Los pedidos confirmados llegarán desde WhatsApp sin digitarlos en cocina.</div>';
  if (r.source === 'cooking-test') content = '<div class="notice"><strong>Prueba de cocina</strong> · Estos pedidos no son ventas. Sigue la receta de cada grupo; tus pesos y comprobaciones se guardan al registrarlos.</div>';
  if (source.localOnly) content = '<p class="notice warning">Entorno local de este computador. Para recibir pedidos reales, WhatsApp y cocina deben usar la misma base de datos del servicio desplegado.</p>' + content;
  return `<details class="source-review" ${r.needsSourceReview || r.sync?.issues.length ? 'open' : ''}><summary>Revisión de pedidos y cancelaciones</summary>${content}</details>`;
}
function batchLabel(batch) {
  if (batch.label) return batch.label;
  if (batch.id === 'all') return 'Toda la jornada';
  if (batch.id === 'unassigned') return 'Sin franja asignada';
  const time = value => new Date(value).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });
  return `${time(batch.startsAt)} – ${time(batch.endsAt)}`;
}
function periodCards(r, cards) {
  const ids = new Set(ordersInBatch(r, prepBatchId || 'all').map(o => o.id));
  return cards.filter(c => ids.has(c.order.id));
}
function periodControls(r, id) {
  const batches = r.preparation || [];
  return `<div class="prep-controls"><label>Horario de entrega<select id="${id}" data-service-period>${batches.map(b => `<option value="${esc(b.id)}" ${b.id === prepBatchId ? 'selected' : ''}>${esc(b.id === 'all' ? 'Todo el día' : batchLabel(b))} · ${b.orderCount} pedidos</option>`).join('')}</select></label></div>`;
}
function pendingKitchenHTML(r) {
  const batch=r.preparation?.find(b=>b.id===prepBatchId);
  const pending=(r.pendingKitchenOrders||[]).filter(o=>!prepBatchId||prepBatchId==='all'||(batch?.windowIds||[prepBatchId]).includes(o.deliveryWindowId));
  if(!pending.length)return '';
  return `<section class="notice warning"><h3>Pedidos pendientes · tener en cuenta</h3>${pending.map(o=>`<article><strong>${esc(o.customer)} · ${esc(o.reference)}</strong><p>${esc(o.summary)} · ${money(o.totalCop)}</p><p>${esc(o.address)}</p><strong>Pendiente de pago${o.selectionPending?' y elección del combo':''}</strong></article>`).join('')}<p>Visibles para cocina. Sus ingredientes se suman al confirmar el pago y la selección.</p></section>`;
}
function periodCounts(r) {
  const orders = ordersInBatch(r, prepBatchId || 'all'), lines = orders.flatMap(o => o.lines);
  const context = kanikamaContext(r, catalog.document), shrimp = shrimpForLines(lines, context.definitions), kani = kanikamaForLines(lines, context);
  const label = batchLabel(r.preparation?.find(b => b.id === prepBatchId) || {id:'all'});
  return `<div class="notice"><strong>${esc(label)} · ${orders.length} pedidos</strong><p>${shrimp.count} langostinos · ${kani.unresolved ? 'Kanikama: conteo por revisar' : `${kani.estimated ? '≈ ' : ''}${kani.count} piezas de kanikama`}</p></div>`;
}
function renderPreparation() {
  if (!selected) { $('#prep').innerHTML = blank; return; }
  const r = selected.document, batches = [...(r.preparation || [])].sort((a, b) => Number(b.id === 'all') - Number(a.id === 'all'));
  if (prepRunId !== r.id || !batches.some(b => b.id === prepBatchId)) {
    prepRunId = r.id;
    prepBatchId = batches.find(b => b.id === 'all')?.id || batches[0]?.id;
  }
  const batch = batches.find(b => b.id === prepBatchId);
  if (!batch) { $('#prep').innerHTML = '<div class="empty">No se pudo cargar el resumen. Actualiza la página.</div>'; return; }
  const progress = packingProgress(r, batch.id), presentation = preparationCards(batch, r, catalog.document, preparationQuantity);
  const choiceLabel = b => b.id === 'all' ? 'Todo el día' : batchLabel(b);
  $('#prep').innerHTML = `<div class="recipe-intro"><div><p class="eyebrow">PREPARACIÓN · ${esc(kitchenDate(r.date))}</p><h2>Todo lo que necesitas</h2><p>Ingredientes sumados de los pedidos confirmados de esta entrega.</p></div><button id="print-prep" class="secondary" ${!batch.orderCount ? 'disabled' : ''}>Imprimir preparación</button></div>
  <div class="prep-controls"><label>Ingredientes para<select id="prep-batch">${batches.map(b => `<option value="${esc(b.id)}" ${b.id === batch.id ? 'selected' : ''}>${esc(choiceLabel(b))}</option>`).join('')}</select></label><p class="muted"><strong>${progress.total} pedidos</strong> · ${progress.packed} empacados</p></div>
  ${pendingKitchenHTML(r)}<p class="prep-caption"><strong>${esc(batchLabel(batch))}</strong> · ${esc(kitchenDate(r.date))}</p>
  <section aria-label="Bebidas y kits para esta entrega"><h3>Bebidas y kits · esta entrega</h3><div class="prep-grid">${presentation.supplies.map(s => `<article class="card prep-ingredient"><h3>${esc(s.name)}</h3><strong class="prep-amount">${s.quantity.toLocaleString('es-CO')} ${esc(s.unit)}</strong><p class="muted">${esc(s.detail)}</p></article>`).join('')}</div></section>
  <details class="prep-count-help print-hide"><summary>Cómo se cuenta un pedido empacado</summary><p>Un pedido queda empacado cuando has comprobado todo lo que lleva en <b>Empacar</b>, incluidos sus diferentes picantes y adicionales. Siempre cuenta como un solo pedido.</p></details>
  ${r.phase === 'planning' ? '<p class="notice">Las cantidades se actualizan con los pedidos y cancelaciones. Revísalas antes de empezar a cocinar.</p>' : ''}
  ${batch.id === 'unassigned' ? '<p class="notice warning">Estos pedidos no tienen franja asignada. No están incluidos en ninguna entrega específica.</p>' : ''}
  <div class="prep-grid">${presentation.cards.map(q => `<article class="card prep-ingredient${q.kind === 'shrimp' ? ' prep-pull' : ''}"><h3>${esc(q.name)}</h3><strong class="prep-amount">${esc(q.amount)}</strong>${q.detail ? `<p class="muted">${esc(q.detail)}</p>` : ''}${q.basis || q.packingNote ? `<details><summary>Cómo preparar</summary><p>${esc(q.basis)}</p>${q.packingNote ? `<p>${esc(q.packingNote)}</p>` : ''}</details>` : ''}</article>`).join('') || '<div class="empty"><h2>No hay pedidos confirmados para esta entrega</h2><p>Los ingredientes aparecerán aquí cuando lleguen los pedidos.</p></div>'}</div>
  ${batch.sauces.length ? `<div class="card"><h3>Salsa por picante</h3><div class="prep-sauces">${batch.sauces.map(s => `<p><strong>${esc(s.heat || 'Sin picante indicado')}</strong><br>${s.ounces ? `${s.ounces.toLocaleString('es-CO', {maximumFractionDigits: 2})} oz de salsa` : `${s.bags} grupos de preparación`}</p>`).join('')}</div></div>` : ''}
  ${periodCounts(r)}
  ${batch.orderCount ? '<p class="muted print-hide">Este resumen incluye también los pedidos ya empacados. En <b>Cada pedido</b> encontrarás cómo repartirlo.</p>' : ''}
  <p class="print-only">Impreso ${esc(new Date().toLocaleString('es-CO', {timeZone:'America/Bogota'}))} · revisión ${selected.version}. Comprueba las cantidades actualizadas antes de cocinar.</p>`;
}
async function printPreparation() {
  try {
    if (!selected) return;
    selected = await api(`runs/${selected.document.id}`); render();
    if (selected.document.sync?.issues.length || selected.document.needsSourceReview) throw new Error('Resuelve la revisión de WhatsApp antes de imprimir.');
    document.body.classList.add('printing-prep');
    window.print();
  } catch (error) { msg(error.message, true); }
  finally { document.body.classList.remove('printing-prep'); }
}
const partHeading = part => part.heat ? `Picante ${part.heat}` : 'Adicionales / sin picante indicado';
const packingText = value => String(value ?? '').replace(/\b(?:picante\s+)?suave(?:\s+(?:estándar|por defecto))?\b/gi,'').replace(/ +([,.;])/g,'$1').replace(/ {2,}/g,' ').trim();
const packingPartHeading = part => (part.packingLabel ? part.packingLabel + (part.repeatCount > 1 ? ` · Repetir × ${part.repeatCount}` : '') : '') || (part.heat && part.heat !== 'Suave' ? `Picante ${part.heat}` : 'Comida');
const lineLabel = line => `${line.name}${line.quantity !== line.baseQuantity ? ` × ${line.quantity / line.baseQuantity}` : ''}`;
const cornFactor = i => isCorn(i) && (i.packFactor || 1) === 1 ? (i.id === 'test-half-corn' ? 2 : 4) : 1;
const prepAmount = (i, value=i.quantity) => value * cornFactor(i);
const prepUnit = ingredient => ingredient.unit === 'piece' && (ingredient.packFactor || 1) === 1 ? isSausage(ingredient) ? 'salchichas enteras' : isCorn(ingredient) ? 'pedazos de mazorca' : unit(ingredient.unit) : unit(ingredient.unit);
function orderHeading(order) {
  const combos = order.lines.filter(comboType);
  return combos.length ? combos.map(lineLabel).join(' + ') + (order.lines.some(line => !comboType(line)) ? ' + adicionales' : '') : 'Pedido personalizado';
}
const startHelp = '<p>Puedes consultar las recetas y cantidades sin iniciar cocina.</p><ol><li><b>Preparar y cocinar:</b> aparecen <b>Registrar lote</b> para anotar cantidades preparadas y <b>Pesar porción</b> para registrar lo que pesaste para cada pedido.</li><li><b>Empacar:</b> aparece <b>Comprobar y empacar</b>. Anotas las piezas o el peso, marcas los ingredientes, salsa, picante y etiqueta. Al guardar todo, el pedido cuenta como empacado.</li></ol><p>El chef hace cada registro; la aplicación no pesa ni marca nada automáticamente.</p>';
function renderOrders() {
  if (!selected) { $('#orders').innerHTML = blank; return; }
  const r = selected.document, context = kanikamaContext(r, catalog.document);
  $('#orders').innerHTML = `<div class="recipe-intro"><div><h2>Qué lleva cada pedido</h2><p>Un recuadro por cliente y pedido. Mazorca y salchicha en pedazos listos para empacar; kanikama en palitos.</p></div>${r.phase === 'planning' && r.orderCount ? '<button data-command="start">Iniciar cocina</button>' : ''}</div>
  ${periodControls(r,'orders-period')}${periodCounts(r)}${pendingKitchenHTML(r)}
  <details class="kitchen-start-help"><summary>¿Qué cambia al iniciar cocina?</summary>${startHelp}</details>
  <div class="order-recipes">${periodCards(r, orderCards(r)).map(({ order, parts, packed }) => `<article class="card order-recipe"><header><span class="eyebrow">PEDIDO ${order.number}</span><h2>${esc(orderHeading(order))}</h2><p class="muted">${esc(order.customer)} · ${esc(order.reference)}</p>${packed ? '<span class="pill good">Empacado</span>' : ''}</header>
  ${parts.map(b => `<section class="order-part"><div class="part-heading"><span class="pill">${esc(partHeading(b))}</span>${parts.length > 1 && b.packed ? '<span class="pill good">Comprobado</span>' : ''}</div>${parts.length > 1 || order.lines.some(l => !comboType(l)) ? `<p class="part-products">${b.lines.map(l => `<strong class="packing-product">${esc(lineLabel(l))}</strong>`).join(' · ')}</p>` : ''}
  <ul class="recipe-items">${orderRecipeCards(b, context, recipeQuantity).map(q => `<li><span>${esc(q.name)}</span><div><strong>${esc(q.amount)}</strong>${q.detail ? `<small>${esc(q.detail)}</small>` : ''}</div></li>`).join('')}</ul>
  ${b.includesSauce ? `<p class="recipe-sauce">Salsa incluida${b.lines.some(l=>l.sauceOz)?' · '+b.lines.reduce((s,l)=>s+(l.sauceOz||0),0).toLocaleString('es-CO',{maximumFractionDigits:2})+' oz':''}${r.source === 'cooking-test' ? ': mantequilla' : ': de la casa'}${b.heat ? ` · ${esc(b.heat)}` : ''}</p>` : ''}</section>`).join('')}
  <details><summary>Notas y referencias de peso</summary>${order.notes ? `<p>${esc(order.notes)}</p>` : ''}${[...new Map(parts.flatMap(b => b.requirements).filter(i => i.packingNote).map(i => [i.id, i])).values()].map(i => `<p><b>${esc(i.name)}:</b> ${esc(i.packingNote)}</p>`).join('')}</details></article>`).join('') || '<div class="empty">Todavía no hay pedidos para preparar.</div>'}</div>
  <p class="muted">Registra los pesos en <b>Preparar y cocinar</b>. Al armar el pedido, usa <b>Empacar</b> para guardar sus comprobaciones.</p>`;
}
function renderDay() {
  if (!selected) { $('#day').innerHTML = blank; return; }
  const r = selected.document, planning = r.phase === 'planning', closed = new Date() >= new Date(r.cutoff), notOpen = r.opensAt && new Date() < new Date(r.opensAt);
  $('#day').innerHTML = `<div class="stats"><div class="stat"><span>Pedidos para preparar</span><strong>${r.orderCount}</strong>${r.source === 'whatsapp' ? `<small>${r.deliveryOrderCount} domicilios · ${r.pickupOrderCount} recogidas / mensajero propio</small>` : ''}</div>${r.source === 'whatsapp' ? `<div class="stat"><span>Reservas de domicilio / cupo</span><strong>${r.sync.deliveryReservations} / ${r.bookingCapacity ?? r.capacity}</strong><small>Incluye reservas pendientes vigentes. Base ${r.capacity} + 20%. Las recogidas no usan cupo.</small></div>` : ''}<div class="stat"><span>Pedidos empacados</span><strong>${packingProgress(r).packed} / ${r.orderCount}</strong></div><div class="stat"><span>Total de comida</span><strong style="font-size:24px">${money(r.totalCop)}</strong></div></div>
  ${sourceStatus(r)}
  <div class="card"><div class="card-head"><div><h2>Entrega ${esc(r.date)}</h2><span class="pill">${phases[r.phase]}</span></div><div class="actions">${planning ? `${r.source !== 'whatsapp' ? `<button data-command="order" ${closed || r.orderCount >= r.capacity || !catalog.document.products.length ? 'disabled' : ''}>+ Pedido manual</button>` : ''}<button class="secondary" data-command="start" ${!r.orderCount ? 'disabled' : ''}>Iniciar cocina</button>` : r.phase === 'cooking' ? '<button data-command="complete">Cerrar jornada</button>' : ''}</div></div>
  ${r.opensAt ? `<p class="muted">Apertura: ${esc(new Date(r.opensAt).toLocaleString('es-CO', {timeZone:'America/Bogota'}))}.</p>` : ''}${r.freezeAfter ? `<p class="muted">Cocina disponible después de ${esc(new Date(r.freezeAfter).toLocaleString('es-CO', {timeZone:'America/Bogota'}))}, cuando termina el plazo de cancelación.</p>` : ''}<p class="muted">Cierre: ${esc(new Date(r.cutoff).toLocaleString('es-CO', { timeZone: 'America/Bogota' }))} · ${!planning ? 'Recepción congelada al iniciar cocina' : closed ? 'Recepción cerrada' : notOpen ? 'Recepción aún no abierta' : 'Recepción abierta'}.</p>
  ${!catalog.document.products.length ? '<div class="notice warning">Configura el menú real antes de registrar pedidos. No hay precios ni recetas de ejemplo cargados.</div>' : ''}
  <div class="scroll"><table><thead><tr><th>Pedido</th><th>Cliente / cocina</th><th>Picante</th><th>Comida acordada</th><th></th></tr></thead><tbody>${r.orders.map(o => `<tr class="${o.cancelled ? 'dim' : ''}"><td><strong>#${o.number} · ${esc(o.reference)}</strong>${o.cancelled ? '<br><small>Cancelado</small>' : ''}</td><td>${esc(o.customer)}${o.deliveryCoverage?.needsReview ? '<br><small>⚠ Entrega por coordinar · revisar en Pedidos</small>' : ''}${o.notes ? `<br><small>${esc(o.notes)}</small>` : ''}${o.cancelled ? `<br><small>${esc(o.cancellationReason)}</small>` : ''}</td><td>${[...new Set(o.lines.map(l => l.heat).filter(Boolean))].map(esc).join(' / ') || '—'}</td><td>${money(o.totalCop)}</td><td>${planning && !o.cancelled && !o.sourceOrderId ? `<button class="quiet" data-command="cancel" data-id="${o.id}">Cancelar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">Aún no hay pedidos en esta jornada.</td></tr>'}</tbody></table></div>
  <details><summary>Registro de cambios (${r.audit.length})</summary><div class="scroll"><table><thead><tr><th>Hora Colombia</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>${r.audit.slice().reverse().map(a => `<tr><td>${esc(new Date(a.at).toLocaleString('es-CO', { timeZone: 'America/Bogota' }))}</td><td>${esc(({ addOrder: 'Pedido registrado', cancel: 'Pedido cancelado', start: 'Cocina iniciada', prep: 'Lote preparado', portion: 'Porción pesada', pack: 'Grupo comprobado', reopen: 'Grupo reabierto', complete: 'Jornada cerrada', sourceAdded:'Pedido de WhatsApp', sourceCancelled:'Retirado desde WhatsApp', sourceIssues:'Revisión de origen', sourceReview:'Grupos reabiertos por cambio', acknowledgeSource:'Cambio revisado' })[a.type])}</td><td>${esc(a.reason || a.bagKey || a.ingredientId || '')}</td></tr>`).join('')}</tbody></table></div></details></div>`;
}
function shrimpCount(lines) { return shrimpForLines(lines, kanikamaContext(selected.document, catalog.document).definitions).count; }
function renderCook() {
  if (!selected) { $('#cook').innerHTML = blank; return; }
  const r = selected.document;
  $('#cook').innerHTML = `<div class="notice">Los totales son <strong>antes de cocinar</strong>, en el estado de pesaje definido en cada receta. Para lotes, pesa cada ingrediente por separado, sin salsa ni empaque. El reparto por lote es una estimación proporcional del peso inicial.</div>
  <div class="card"><h2>Todo lo que debes preparar</h2><div class="scroll"><table><thead><tr><th>Ingrediente</th><th>Total prometido</th><th>Control</th><th>Registro</th><th></th></tr></thead><tbody>${r.totals.map(i => `<tr><td><strong>${esc(i.name)}</strong><br><small>${isShrimp(i)?'Piezas por pedido':esc(i.basis)}</small>${i.packingNote ? `<details><summary>Nota de cocina</summary><p>${esc(i.packingNote)}</p></details>` : ''}</td><td><strong>${isShrimp(i) ? shrimpCount(r.orders.filter(o=>!o.cancelled).flatMap(o=>o.lines))+' langostinos' : prepAmount(i)+' '+prepUnit(i)}</strong>${i.unit === 'piece' && i.packFactor > 1 ? `<br><small>Preparar ${i.quantity * i.packFactor} ${esc(packLabel(i))}</small>` : ''}</td><td>${isShrimp(i)?'Conteo de piezas':methodName(i.method)}</td><td>${i.method === 'portion' ? `${r.bags.filter(b => b.requirements.some(c => c.id === i.id && c.portion)).length} porciones registradas` : i.prep ? `${prepAmount(i,i.prep.raw)} ${prepUnit(i)} iniciales${i.prep.screening ? `<br><small>En rango: ${i.prep.screening.accepted.join(', ')} g<br>Apartar: ${i.prep.screening.setAside.length ? i.prep.screening.setAside.join(', ') + ' g' : 'ninguna'}</small>` : ''}${i.method === 'batch' ? `<br>${i.prep.cooked} g cocidos<br><small>${i.surplus} g cocidos reservados como sobrante</small>` : ''}` : 'Pendiente'}</td><td>${i.method !== 'portion' && r.phase === 'cooking' ? `<button class="secondary" data-command="prep" data-id="${esc(i.id)}">${i.prep ? 'Corregir lote' : 'Registrar lote'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">Añade pedidos para calcular los totales.</td></tr>'}</tbody></table></div></div>
  <div class="card"><h2>Porciones identificadas</h2><p class="muted">Cuenta los langostinos; pesa los demás ingredientes. Mantén su identificación hasta empacarla en su pedido. El peso de la salsa o del empaque no cuenta.</p>${r.bags.flatMap(b => b.requirements.filter(i => i.method === 'portion').map(i => `<div class="requirements"><li><span><strong>#${b.orderNumber} · ${esc(partHeading(b))} · ${esc(b.customer)}</strong><small>${esc(i.name)}${isShrimp(i)?' · contar piezas':' · '+esc(i.basis)}</small></span><strong>${isShrimp(i) ? shrimpCount(b.lines)+' langostinos' : i.quantity+' g'} ${i.portion ? '✓' : ''}</strong>${r.phase === 'cooking' && !b.packed ? `<button class="secondary" data-command="portion" data-key="${esc(b.key)}" data-id="${esc(i.id)}">${isShrimp(i)?'Contar langostinos':i.portion ? 'Revisar peso' : 'Pesar porción'}</button>` : ''}</li></div>`)).join('') || '<p class="muted">No hay ingredientes con control por porción.</p>'}</div>`;
}
function packingBatchHTML(r,cards,definitions) {
  const routeKey=packRouteKey;
  if(!packRoute || !cards.some(c=>routeKey(c)===packRoute))packRoute=routeKey(cards.find(c=>!c.packed)||cards[0]||{});
  const group=orderedColumns(cards.filter(c=>routeKey(c)===packRoute));
  const names=[...new Set(group.flatMap(c=>c.parts.flatMap(b=>b.requirements.filter(i=>!trayItem(i)&&!isPackingSupply(i)).map(i=>i.name))))];
  const label=group[0]?.batch?.label || (packRoute==='hq_walk'?'Entrega a pie · HQ':packRoute==='pickup'?'Recogidas':packRoute==='unassigned'?'Domicilios sin ruta':`Conductor ${group[0]?.route?.driver}${dispatchMode()!=='whole'?' · Viaje '+group[0]?.route?.trip:''}`);
  return `<section class="packing-batch"><h2>${esc(label)} · ${group.length} pedidos juntos</h2><p>Completa una fila de ingredientes en todos los pedidos y sigue con la siguiente. Toca cada cantidad para marcarla en verde. Las marcas se guardan; al final, comprueba cada pedido.</p><div class="batch-navigation print-hide"><button type="button" class="secondary" data-batch-scroll="ingredients">Ir a ingredientes ↓</button><button type="button" class="quiet" data-batch-scroll="notes">Ver pedido e indicaciones ↑</button></div><div class="batch-scroll" tabindex="0" role="region" aria-label="Ingredientes para empacar; desliza para ver todas las filas"><table class="batch-table" style="min-width:${Math.max(760,190+group.length*260)}px"><thead><tr><th>Ingrediente</th>${group.map((c,index)=>`<th><div class="column-controls"><button class="secondary" data-column-id="${esc(c.order.id)}" data-column-move="-1" ${index===0||(!c.route&&!c.batch)||c.route?.fulfillment==='hq_walk'?'disabled':''} aria-label="Mover a la izquierda">←</button><button class="secondary" data-column-id="${esc(c.order.id)}" data-column-move="1" ${index===group.length-1||(!c.route&&!c.batch)||c.route?.fulfillment==='hq_walk'?'disabled':''} aria-label="Mover a la derecha">→</button></div><strong class="packing-customer">${esc(packingCustomerName(c.order))}</strong><small>${esc(c.order.reference)}${c.route?` · Parada ${c.route.stop}`:''}</small></th>`).join('')}</tr></thead><tbody><tr class="batch-order-details"><th>Pedido e indicaciones</th>${group.map(c=>`<td><div class="packing-product-summary">${packingProductSummary(c.order.lines).map(label=>esc(packingText(label))).join('<br>')}</div>${packingSections(c.parts).some(b=>b.repeatCount>1)?'<p class="packing-serving-note">Cantidades para 1 combo. Repetir según la cantidad pedida.</p>':''}${c.order.deliveryCoverage?.packingInstructions?`<p class="note">${esc(c.order.deliveryCoverage.packingInstructions)}</p>`:''}</td>`).join('')}</tr>${names.map(name=>`<tr class="packing-ingredient-row"><th>${esc(name)}</th>${group.map(c=>`<td>${packingSections(c.parts).flatMap(b=>b.requirements.filter(i=>i.name===name).map(i=>{
    const count=packingCountPlan(i,b.lines,definitions),cuts=cutPackingPlan(i,b.lines,definitions);
    const q=count||cuts||(isShrimp(i)?{amount:shrimpCount(b.lines)+' langostinos'}:recipeQuantity(i));
    const checked=packingCellChecked(r,b,i);
    return `<button class="batch-check ${checked?'checked':''}" aria-pressed="${checked}" data-pack-check data-key="${esc(b.key)}" data-id="${esc(i.id)}" ${b.packed?'disabled':''}><span>${checked?'✓':'○'} ${esc(q.amount)}</span>${b.packingLabel||c.parts.length>1?`<small>${esc(packingPartHeading(b))}</small>`:''}</button>`;
  })).join('')||'<span class="batch-none">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody><tfoot><tr><th>Terminar pedido</th>${group.map(c=>`<td>${c.packed?'<span class="pill good">Empacado ✓</span>':`<button class="secondary" data-pack-pick="${esc(c.order.id)}">Revisar y cerrar</button>`}</td>`).join('')}</tr></tfoot></table></div><p class="muted">Verde = ingrediente marcado. «Empacado» requiere la comprobación final del pedido.</p></section>`;
}
document.addEventListener('click',async e=>{
  const jump=e.target.closest('[data-batch-scroll]');
  if(jump){const section=jump.closest('.packing-batch'),scroll=section.querySelector('.batch-scroll'),row=section.querySelector('.packing-ingredient-row'),head=section.querySelector('thead');if(scroll){const top=jump.dataset.batchScroll==='ingredients'&&row?scroll.scrollTop+row.getBoundingClientRect().top-scroll.getBoundingClientRect().top-(head?.getBoundingClientRect().height||0)-2:0;scroll.scrollTo({top:Math.max(0,top),behavior:'smooth'});}return;}
  const move=e.target.closest('[data-column-move]');
  if(move){if(busy)return;const group=orderedColumns(packingQueue(selected.document,'saved').filter(c=>packRouteKey(c)===packRoute));const visible=periodCards(selected.document,group),vi=visible.findIndex(c=>c.order.id===move.dataset.columnId),vj=vi+Number(move.dataset.columnMove);const i=group.findIndex(c=>c.order.id===visible[vi]?.order.id),j=vj>=0&&vj<visible.length?group.findIndex(c=>c.order.id===visible[vj].order.id):-1;if(i>=0&&j>=0&&j<group.length&&(group[0]?.route||group[0]?.batch)){[group[i],group[j]]=[group[j],group[i]];busy=true;try{await api('routes/plan',{date:selected.document.date,expectedGroups:selected.document.packingRoutes,batchId:group[0].batch?.id,expectedBatches:selected.document.packingBatches,driver:group[0].route?.driver,trip:group[0].route?.trip,references:group.map(c=>c.order.reference)});selected=await api('runs/'+selected.document.id);renderPack();msg('Orden guardado en Empacar y Rutas para todos los dispositivos.');}catch(error){msg(error.message,true);}finally{busy=false;}}return;}
  const route=e.target.closest('[data-pack-route]');
  if(route){packMode='batch';packRoute=route.dataset.packRoute;renderPack();return;}
  if(e.target.closest('[data-pack-batch]')){packMode='batch';renderPack();return;}
  const button=e.target.closest('[data-pack-check]');if(!button||busy)return;
  const bag=packingSections(selected.document.bags).find(b=>b.key===button.dataset.key),item=bag?.requirements.find(i=>i.id===button.dataset.id);if(!item)return;
  busy=true;document.querySelectorAll('[data-pack-check]').forEach(b=>b.disabled=true);
  const x=window.scrollX,y=window.scrollY,scroll=$('.batch-scroll')?.scrollLeft||0;
  try{await mutate({type:'packingCheck',bagKey:bag.key,ingredientId:item.id,signature:packingCellSignature(bag,item),checked:!packingCellChecked(selected.document,bag,item)});}
  catch(error){msg(error.message,true);}
  finally{busy=false;renderPack();if($('.batch-scroll'))$('.batch-scroll').scrollLeft=scroll;window.scrollTo(x,y);}
});
function renderPack() {
  const previousScroll=$('.batch-scroll'),savedScroll=previousScroll?{top:previousScroll.scrollTop,left:previousScroll.scrollLeft}:null;
  if (!selected) { $('#pack').innerHTML = blank; return; }
  const r = selected.document, cards = periodCards(r, packingQueue(r,dispatchMode())), definitions = kanikamaContext(r, catalog.document).definitions;
  if (activePackOrderId !== 'all' && !cards.some(c => c.order.id === activePackOrderId)) activePackOrderId = cards.find(c => !c.packed)?.order.id || cards[0]?.order.id;
  $('#pack').innerHTML = `<div class="print-only"><h1>King Cajun · ${esc(kitchenDate(r.date))}</h1><p>Hoja de control · ${r.orderCount} pedidos · revisión ${selected.version}</p><p>Impreso ${esc(new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }))}. Comprueba la revisión en la aplicación antes de trabajar. ${r.phase === 'planning' ? 'PLAN PROVISIONAL: revisa las cantidades antes de cocinar.' : ''}</p></div>
  ${periodControls(r,'pack-period')}${periodCounts(r)}${pendingKitchenHTML(r)}
  <form id="rider-count-form" class="rider-count-form print-hide"><label>Domiciliarios hoy<input name="count" type="number" min="1" max="12" step="1" required value="${r.dispatchOverride?.riderCount || r.packingRoutes?.length || 1}"></label><button type="submit">Actualizar rutas</button><span>Se guarda para todos los dispositivos. Las marcas de empaque se conservan.</span></form><label class="print-hide">Plan de salida · compartido con Rutas<select id="dispatch-mode"><option value="saved" selected>Plan guardado para esta fecha</option><option value="whole">Cambiar a un viaje por conductor</option><option value="split">Cambiar a dos viajes por conductor</option></select></label>
  <p>${r.packingBatches?.length?'Seguir las tandas guardadas, en el orden indicado. Preparar cada grupo junto y conservar los siguientes calientes en cocina.':dispatchMode()==='saved'?'Empacar por conductor y viaje según el plan acordado. Dejar la segunda tanda en cocina hasta el regreso del domiciliario.':dispatchMode()==='split'?'Empacar primero los viajes 1. Dejar los viajes 2 calientes en cocina y empacarlos cuando regrese el conductor (segunda salida prevista 8:00–8:10 p. m.). Itagüí conserva un solo viaje.':'Empacar todos los pedidos del conductor juntos para una sola salida.'} ${r.date==='2026-10-17'?'Camcam: antes de 7:45 p. m. Camila: solo 8–9 p. m.':''}</p>
  <div class="pack-routes print-hide">${[...new Set(cards.map(packRouteKey))].map(key=>{const group=cards.filter(c=>packRouteKey(c)===key),route=group[0]?.route;return `<button class="secondary" data-pack-route="${key}"><strong>${group[0]?.batch?esc(group[0].batch.label):route?.fulfillment==='hq_walk'?'Entrega a pie · HQ':route?'Conductor '+route.driver+(dispatchMode()!=='whole'?' · Viaje '+route.trip:''):key==='pickup'?'Recogidas':'Domicilios sin ruta'}</strong><span>${group.filter(c=>c.packed).length}/${group.length} empacados</span></button>`;}).join('')}</div>
  ${packMode==='single'?'<button class="secondary" data-pack-batch>← Ver grupo completo</button>':''}
  ${packMode==='batch'?packingBatchHTML(r,cards,definitions):''}
  <div class="pack-finder print-hide"><label>Buscar pedido<input id="pack-search" type="search" placeholder="Nombre, teléfono o número de pedido" value="${esc(packSearchQuery)}" autocomplete="off"></label><div id="pack-search-results" class="pack-search-results"></div><div class="toolbar"><label>Pedido activo<select id="pack-order-select"><option value="all" ${activePackOrderId === 'all' ? 'selected' : ''}>Ver todos los pedidos</option>${cards.map(({ order, packed }) => `<option value="${esc(order.id)}" ${activePackOrderId === order.id ? 'selected' : ''}>${packed ? '✓' : '○'} ${cards.find(c=>c.order.id===order.id)?.route ? 'Conductor '+cards.find(c=>c.order.id===order.id).route.driver+' · ' : 'Recogida / sin ruta · '}#${order.number} · ${esc(order.customer)} · ${esc(order.reference)}</option>`).join('')}</select></label><span class="muted">${cards.filter(c => !c.packed).length} pendientes de ${cards.length} pedidos</span></div></div>
  <div class="notice print-hide">Comprueba todo lo que lleva el pedido. Revisa también las adiciones de comida dentro del mismo recuadro. Mazorca y salchicha se cuentan en pedazos ya cortados.</div>
  ${cards.map(({ order, parts, packed, route }) => `<article class="card bag-card" ${packMode==='batch' || activePackOrderId !== 'all' && activePackOrderId !== order.id ? 'hidden' : ''}><div class="card-head"><div><div class="bag-label">Pedido #${order.number}</div><p class="route-label">${route ? `Conductor ${route.driver} · Parada ${route.stop}` : 'Recogida / sin ruta asignada'}</p><strong class="packing-customer">${esc(kitchenName(order))}</strong><p class="packing-phones">${kitchenPhones(order).map(p=>`<a href="tel:${esc(p)}">${esc(p)}</a>`).join(" · ") || "Teléfono pendiente"}</p><p class="muted">${esc(order.reference)} · ${esc(kitchenDate(r.date))}</p></div><span class="pill ${packed ? 'good' : ''}">${packed ? 'Empacado ✓' : 'Por empacar'}</span></div>
  ${order.notes ? `<p class="note">${esc(packingText(order.notes))}</p>` : ''}
  ${packingSections(parts).map(b => `<section class="order-part"><div class="part-heading"><span class="pill">${esc(packingPartHeading(b))}</span>${parts.length > 1 && b.packed ? '<span class="pill good">Comprobado ✓</span>' : ''}</div><p class="part-products">${b.lines.filter(l=>!isPackingSupply(l)).map(l => `<strong class="packing-product">${esc(packingText(lineLabel(l)))}</strong>`).join(' · ')}</p>${b.perCombo ? `<p class="note">Cantidades para 1 combo${b.repeatCount>1?` · repetir ${b.repeatCount} veces`:""}.</p>` : ""}${b.includesSauce ? '<p class="note">Salsa de la casa incluida</p>' : ''}
  <ul class="requirements">${b.requirements.filter(i=>!trayItem(i)&&!isPackingSupply(i)).map(i => {
    const counts = packingCountPlan(i,b.lines,definitions);
    const cuts = counts || (isShrimp(i) ? {amount:shrimpCount(b.lines)+' langostinos',detail:'Contar piezas para este pedido.'} : cutPackingPlan(i, b.lines, definitions));
    return `<li><span>${esc(i.name)}<small>${cuts ? esc(cuts.detail) : `Prometido: ${i.quantity} ${unit(i.unit)} · ${esc(i.basis)}`}</small>${i.packingNote ? `<small>${esc(packingText(i.packingNote))}</small>` : ''}</span><strong>${cuts ? esc(cuts.amount) : i.method === 'portion' ? `Porción identificada${i.portion ? ' ✓' : ' · falta pesar'}` : i.unit === 'piece' ? `${i.packQuantity} ${esc(packLabel(i))}` : i.target !== null ? `${i.target} g cocidos` : 'Falta pesar el lote'}</strong></li>`;
  }).join('')}</ul><div class="row-actions">${r.phase === 'cooking' ? (b.sourceBagKeys||[b.key]).map(key=>{const source=parts.find(p=>p.key===key);return `<button data-command="${source.packed?'reopen':'pack'}" data-key="${esc(key)}" class="${source.packed?'secondary':''}">${source.packed?'Reabrir para corregir':'Comprobar y empacar'}${parts.length>1?` · ${esc(source.heat||'Adiciones')}`:''}</button>`;}).join('') : ''}</div><p class="print-only">${esc(packingPartHeading(b))} · Porciones comprobadas ☐ · Etiqueta verificada ☐</p></section>`).join('')}
  <small>Total de comida del pedido completo: ${money(order.totalCop)}</small></article>`).join('') || '<div class="empty">Los pedidos aparecerán aquí con sus instrucciones de empaque.</div>'}`;
  renderPackSearch();
  if(savedScroll&&$('.batch-scroll')){ $('.batch-scroll').scrollTop=savedScroll.top;$('.batch-scroll').scrollLeft=savedScroll.left; }
}
function renderPackSearch() {
 const el=$('#pack-search-results');if(!el||!selected)return;
 const matches=periodCards(selected.document, orderCards(selected.document)).filter(c=>matchesKitchenOrder(c.order,packSearchQuery));
 el.innerHTML=packSearchQuery.trim()?matches.map(({order,packed})=>`<button type="button" data-pack-pick="${esc(order.id)}"><strong class="packing-customer">${esc(kitchenName(order))}</strong><span>${esc(kitchenPhones(order).join(' · ')||'Teléfono pendiente')} · #${order.number} · ${esc(order.reference)} · ${packed?'Empacado':'Por empacar'}</span></button>`).join('')||'<p>No se encontró ese pedido.</p>':'';
}
document.addEventListener('input', e=>{if(e.target.id==='pack-search'){packSearchQuery=e.target.value;renderPackSearch();}});
document.addEventListener('click', e=>{const button=e.target.closest('[data-pack-pick]');if(!button)return;packMode='single';activePackOrderId=button.dataset.packPick;packSearchQuery='';renderPack();$('#pack .bag-card:not([hidden])')?.scrollIntoView({block:'start',behavior:'smooth'});});
function renderMenu() {
  const c = catalog.document;
  if(catalog.managed){$('#menu').innerHTML=`<div class="card"><h2>Costos y menú</h2><p>La versión ${catalog.version} se actualiza automáticamente para cocina y WhatsApp. Los pedidos conservan su receta original.</p><a href="/costos">Editar ingredientes, recetas y precios</a></div>${c.products.map(p=>`<article class="card"><h3>${esc(p.name)} · ${money(p.priceCop)}</h3><p>${esc(p.description)}</p></article>`).join('')}`;return;}
  $('#menu').innerHTML = `<div class="card"><h2>Un solo menú para WhatsApp y cocina</h2><p>${source.linkedProducts} productos conectados. Al conectar, WhatsApp ofrecerá este menú y guardará la receta con cada venta. Las ediciones posteriores requieren volver a conectar para actualizar lo que se vende.</p><button data-command="publishMenu">Conectar este menú a WhatsApp</button></div><div class="notice">Define las reglas del menú real. Las recetas y precios quedan guardados en cada pedido; cambiarlos aquí solo afecta pedidos nuevos. Los ingredientes se miden en gramos enteros o piezas enteras.</div>
  <div class="card"><div class="card-head"><div><h2>Ingredientes</h2><p class="muted">Qué pesar, en qué estado y cómo controlarlo.</p></div><button data-command="ingredient">+ Ingrediente</button></div><div class="scroll"><table><thead><tr><th>Nombre</th><th>Unidad y estado</th><th>Método</th><th></th></tr></thead><tbody>${c.ingredients.map(i => `<tr><td>${esc(i.name)}</td><td>${unit(i.unit)} · ${esc(i.basis)}${i.unit === 'piece' && i.packFactor > 1 ? `<br><small>${i.packFactor} ${esc(packLabel(i))} por unidad</small>` : ''}</td><td>${methodName(i.method)}</td><td><button class="quiet" data-command="ingredient" data-id="${esc(i.id)}">Editar</button></td></tr>`).join('') || '<tr><td colspan="4">Pendiente del menú. Empieza por los ingredientes.</td></tr>'}</tbody></table></div></div>
  <div class="card"><div class="card-head"><div><h2>Productos y combos</h2><p class="muted">Precio y composición por cantidad base.</p></div><button data-command="product" ${!c.ingredients.length ? 'disabled' : ''}>+ Producto</button></div>${c.products.map(p => `<div class="card-head"><div><strong>${esc(p.name)}</strong><p class="muted">${money(p.priceCop)} por ${p.baseQuantity} ${unit(p.unit)}${p.description ? `<br>${esc(p.description)}` : ''}${p.includesSauce ? '<br>Salsa de la casa incluida' : ''}${p.requiresHeat ? ' · Picante Suave / Medio' : ''}<br>${p.components.map(x => { const i = c.ingredients.find(i => i.id === x.ingredientId); return `${x.quantity} ${unit(i.unit)} ${esc(i.name)}`; }).join(' + ')}</p></div><button class="secondary" data-command="product" data-id="${esc(p.id)}">Editar</button></div>`).join('') || '<p class="muted">Aún no hay productos configurados.</p>'}</div>`;
}
async function mutate(action) {
  ++runRequestVersion;
  selected = await api(`runs/${selected.document.id}/actions`, { version: selected.version, catalogVersion: catalog.version, action });
  const r = selected.document, summary = { id: r.id, date: r.date, phase: r.phase, count: r.orderCount, capacity: r.capacity, bookingCapacity: r.bookingCapacity, source:r.source, deliveryReservations:r.sync?.deliveryReservations };
  runs = runs.map(x => x.id === r.id ? summary : x); if (action.type === 'pack') {activePackOrderId=null;packRoute=null;packMode='batch';} render(); msg('Guardado.');
}
const ingredientOptions = value => catalog.document.ingredients.map(i => `<option value="${esc(i.id)}" ${value === i.id ? 'selected' : ''}>${esc(i.name)} · ${unit(i.unit)}</option>`).join('');
function componentRow(value = {}) {
  const row = document.createElement('div'); row.className = 'ingredient-row';
  row.innerHTML = `<label>Ingrediente<select class="component-id">${ingredientOptions(value.ingredientId)}</select></label><label>Cantidad<input class="component-quantity" type="number" min="1" max="100000000" step="1" required value="${value.quantity ?? ''}"></label><button type="button" class="quiet remove" aria-label="Quitar ingrediente">×</button>`;
  $('#components').append(row);
}
function lineRow(value = {}) {
  const row = document.createElement('div'); row.className = 'line-row';
  row.innerHTML = `<label>Producto<select class="line-product">${catalog.document.products.map(p => `<option value="${esc(p.id)}" ${p.id === value.productId ? 'selected' : ''}>${esc(p.name)} · ${unit(p.unit)}</option>`).join('')}</select></label><label>Cantidad<input class="line-quantity" type="number" min="0.001" max="100000000" step="any" value="${value.quantity ?? ''}" required></label><label class="line-heat-label">Picante<select class="line-heat"><option value="">Seleccionar</option><option value="Suave" ${value.heat === 'Suave' ? 'selected' : ''}>Suave</option><option value="Medio" ${value.heat === 'Medio' ? 'selected' : ''}>Medio</option></select></label><label>Grupo número<input class="line-bag" type="number" min="1" max="100" step="1" value="${value.bag ?? 1}" required></label><button type="button" class="quiet remove" aria-label="Quitar producto">×</button>`;
  $('#order-lines').append(row); updateLineHeat(row); row.querySelector('.line-product').addEventListener('change', () => updateLineHeat(row));
}
function updateLineHeat(row) { const p = catalog.document.products.find(p => p.id === row.querySelector('.line-product').value); const heat = row.querySelector('.line-heat'); heat.required = p?.requiresHeat ?? false; heat.disabled = !heat.required; row.querySelector('.line-heat-label').hidden = !heat.required; }
function readOrder() {
  const f = new FormData($('#order-form'));
  return { reference: f.get('reference'), customer: f.get('customer'), notes: f.get('notes'), agreedTotalCop: f.get('agreedTotalCop') === '' ? null : Number(f.get('agreedTotalCop')), lines: [...document.querySelectorAll('#order-lines .line-row')].map(r => ({ productId: r.querySelector('.line-product').value, quantity: Number(r.querySelector('.line-quantity').value), bag: Number(r.querySelector('.line-bag').value), heat: r.querySelector('.line-heat').value })) };
}
let quoteSequence=0;
async function updateQuote() {
  const seq=++quoteSequence;
  try { const quote=await api('quote',{version:catalog.version,order:readOrder()});if(seq===quoteSequence)$('#quote').textContent=money(quote.totalCop); }
  catch(error) { if(seq===quoteSequence)$('#quote').textContent=error.message||'Completa las cantidades'; }
}

function saveDraft() { updateQuote(); try { sessionStorage.setItem(`kitchen-order-${selected.document.id}`, JSON.stringify(readOrder())); $('#order-draft-state').textContent = 'Borrador guardado en esta pestaña. Aún no registrado.'; } catch { $('#order-draft-state').textContent = 'Borrador en pantalla. Aún no registrado.'; } }
function openOrder() {
  $('#order-form').reset(); $('#order-lines').innerHTML = ''; $('#order-draft-state').textContent = '';
  let draft; try { draft = JSON.parse(sessionStorage.getItem(`kitchen-order-${selected.document.id}`)); } catch { /* no stored draft */ }
  if (draft) {
    for (const field of ['reference', 'customer', 'notes', 'agreedTotalCop']) $('#order-form').elements[field].value = draft[field] ?? '';
    draft.lines.forEach(lineRow); $('#order-draft-state').textContent = 'Borrador restaurado. Aún no registrado.';
  } else lineRow();
  updateQuote(); openDialog('#order-dialog');
}
function openIngredient(ingredientId) {
  const f = $('#ingredient-form'); f.reset(); f.elements.id.value = '';
  const value = catalog.document.ingredients.find(i => i.id === ingredientId);
  if (value) for (const k of ['id', 'name', 'unit', 'basis', 'method', 'packLabel', 'packFactor', 'packingNote']) f.elements[k].value = value[k] === 'count' ? 'portion' : value[k] ?? (k === 'packFactor' ? 1 : '');
  f.elements.minGrams.value = value?.screening?.minGrams ?? ''; f.elements.maxGrams.value = value?.screening?.maxGrams ?? ''; f.dataset.version = catalog.version; openDialog('#ingredient-dialog');
}
function openProduct(productId) {
  const f = $('#product-form'); f.reset(); f.elements.id.value = ''; $('#components').innerHTML = '';
  const value = catalog.document.products.find(p => p.id === productId);
  if (value) { for (const k of ['id', 'name', 'unit', 'baseQuantity', 'priceCop', 'description']) f.elements[k].value = value[k]; f.elements.requiresHeat.checked = value.requiresHeat; f.elements.includesSauce.checked = value.includesSauce; value.components.forEach(componentRow); }
  else componentRow();
  f.dataset.version = catalog.version; openDialog('#product-dialog');
}
function openAction(title, fields, handler, button = 'Guardar') {
  $('#action-title').textContent = title; $('#action-fields').innerHTML = fields; $('#action-submit').textContent = button;
  actionHandler = handler; openDialog('#action-dialog');
}
function command(button) {
  const { command: cmd, id, key } = button.dataset;
  if (cmd === 'ingredient') return openIngredient(id);
  if (cmd === 'product') return openProduct(id);
  if (cmd === 'publishMenu') return openAction('Conectar menú', '<p>WhatsApp ofrecerá estos productos y precios. Los productos anteriores dejarán de ofrecerse; los pedidos existentes conservan lo acordado.</p>', async () => { await api('publish-menu', {version:catalog.version}); source = await api('source'); renderMenu(); msg('Menú conectado. No se envió ningún mensaje a clientes.'); }, 'Conectar menú');
  if (!selected) return;
  const r = selected.document;
  if (cmd === 'acknowledgeSource') return openAction('Revisar cambios de WhatsApp', '<label>Qué sobrantes, porciones y etiquetas revisaste<textarea name="reason" maxlength="500" required></textarea></label>', f=>mutate({type:'acknowledgeSource',reason:f.get('reason')}));
  if (cmd === 'order') return openOrder();
  if (cmd === 'start') return openAction('Iniciar cocina', '<p>La jornada pasa a <strong>En cocina</strong>.</p>' + startHelp + '<p>Se comprueban los pedidos y cancelaciones antes de iniciar. Deben estar resueltas las incidencias y haber terminado el cierre de pedidos y el plazo de 12 horas antes de cada entrega.</p><p>Los pedidos que se confirmen después requieren revisión para incorporarlos. Si se cancela un pedido, se retiran sus cantidades y se pide revisar lo ya preparado.</p><p class="muted">Este botón no envía mensajes a clientes.</p>', () => mutate({ type: 'start' }), 'Confirmar e iniciar cocina');
  if (cmd === 'complete') return openAction('Cerrar jornada', '<p>Todos los pedidos deben estar comprobados, incluidos sus adicionales. Al cerrar, la jornada quedará como registro terminado de cocina. Esto no marca los pedidos como entregados al cliente.</p>', () => mutate({ type: 'complete' }), 'Cerrar jornada');
  if (cmd === 'cancel' || cmd === 'reopen') return openAction(cmd === 'cancel' ? 'Cancelar en cocina' : 'Corregir comprobación', '<label>Motivo<textarea name="reason" maxlength="500" required></textarea></label><p class="muted">El cambio queda registrado. Los pedidos y pagos del sistema de ventas no se modifican.</p>', f => mutate({ type: cmd, orderId: id, bagKey: key, reason: f.get('reason') }));
  if (cmd === 'prep') {
    const i = r.totals.find(i => i.id === id);
    return openAction(`Preparar ${i.name}`, `<p>Prometido: <strong>${prepAmount(i)} ${prepUnit(i)}</strong> · ${esc(i.basis)}</p>${i.packingNote ? `<p class="note">${esc(i.packingNote)}</p>` : ''}${i.screening ? `<label>Peso inicial de cada pieza revisada · g<textarea name="pieceWeights" rows="3" required placeholder="Ej. 280, 310, 240">${i.prep?.screening ? [...i.prep.screening.accepted, ...i.prep.screening.setAside].join(', ') : ''}</textarea></label><p class="muted">Separa los pesos con coma o salto de línea. Solo se cuentan piezas entre ${i.screening.minGrams} y ${i.screening.maxGrams} g. Las demás se marcan para apartar. No recortes una pieza para hacerla entrar al rango.</p>` : `<label>Cantidad inicial real · ${prepUnit(i)}<input name="raw" type="number" min="${prepAmount(i)}" max="100000000" step="${isCorn(i)?1:'any'}" value="${i.prep ? prepAmount(i,i.prep.raw) : ''}" required></label>`}${i.method === 'batch' ? `<label>Peso cocido neto del mismo lote · g<input name="cooked" type="number" min="1" max="100000000" step="any" value="${i.prep?.cooked ?? ''}" required></label><p class="muted">Pesa antes de añadir salsa. La aplicación reparte el peso cocido según el peso inicial de cada pedido y separa el sobrante. Es una estimación proporcional, no una prueba del peso inicial individual.</p>` : ''}`, f => mutate({ type: 'prep', ingredientId: id, raw: Number(f.get('raw')) / cornFactor(i), pieceWeights: i.screening ? String(f.get('pieceWeights')).trim().split(/[,\s]+/).map(Number) : undefined, cooked: i.method === 'batch' ? Number(f.get('cooked')) : null }));
  }
  const bag = r.bags.find(b => b.key === key);
  if (cmd === 'portion') {
    const i = bag.requirements.find(i => i.id === id);
    if (isShrimp(i)) return openAction(`Contar langostinos · ${bag.customer}`, `<p>Para este pedido: <strong>${shrimpCount(bag.lines)} langostinos</strong>.</p><label>Número de langostinos contados<input name="countedPieces" type="number" min="1" step="1" required></label><label class="check"><input name="identified" type="checkbox" required>Separados e identificados para este pedido y picante.</label>`, f=>mutate({type:'portion',ingredientId:id,bagKey:key,countedPieces:Number(f.get('countedPieces')),identified:f.get('identified')==='on'}));
    return openAction(`#${bag.orderNumber} · ${partHeading(bag)} · ${i.name}`, `<p>${esc(bag.customer)} · ${esc(bag.reference)}</p><p>Pesa <strong>${prepAmount(i)} ${prepUnit(i)}</strong> · ${esc(i.basis)}.</p><label>Cantidad neta de esta porción · ${unit(i.unit)}<input name="raw" type="number" min="0.000001" step="any" max="100000000" value="${i.portion?.raw ?? ''}" required></label><label class="check"><input name="identified" type="checkbox" required>La porción queda identificada para este pedido y picante durante la cocción.</label>`, f => mutate({ type: 'portion', ingredientId: id, bagKey: key, raw: Number(f.get('raw')), identified: f.get('identified') === 'on' }));
  }
  if (cmd === 'pack') {
    const definitions = kanikamaContext(r, catalog.document).definitions;
    const foodRequirements = bag.requirements.filter(i=>!isPackingSupply(i));
    return openAction(`Pedido #${bag.orderNumber} · ${partHeading(bag)}`, `<p><strong>${esc(bag.customer)}</strong> · ${esc(bag.reference)}</p><p>${bag.lines.filter(l=>!isPackingSupply(l)).map(l => esc(packingText(lineLabel(l)))).join(' · ')}</p>${bag.notes ? `<p class="note">${esc(packingText(bag.notes))}</p>` : ''}${foodRequirements.map((i, n) => {
      const cuts = isShrimp(i) ? {amount:shrimpCount(bag.lines)+' langostinos',detail:'Contar '+shrimpCount(bag.lines)+' langostinos para este pedido.'} : cutPackingPlan(i, bag.lines, definitions);
      const countPlan=packingCountPlan(i,bag.lines,definitions);
      if(countPlan)return `<div class="card"><h3>${esc(i.name)}</h3><p><strong>${esc(countPlan.amount)}</strong></p><p>${esc(countPlan.detail)}</p><label>Cantidad empacada<input name="count${n}" type="number" min="${countPlan.count}" max="${countPlan.count}" step="any" required></label><label class="check"><input name="check${n}" type="checkbox" required>Contado y empacado para este pedido.</label></div>`;
      return `<div class="card"><h3>${esc(i.name)}</h3><p class="muted">${cuts ? esc(cuts.detail) : `Prometido: ${i.quantity} ${unit(i.unit)} · ${esc(i.basis)}`}</p>${i.method === 'portion' ? `<p>${isShrimp(i)?(i.portion?.countedPieces?'Langostinos contados e identificados ✓':'Falta contar los langostinos en Preparar y cocinar.'):i.portion ? 'Porción inicial pesada e identificada ✓' : 'Falta pesar la porción en Preparar y cocinar.'}</p><label class="check"><input name="check${n}" type="checkbox" required>Empaqué la porción cocida identificada para este pedido.</label>` : `<p><strong>Objetivo: ${cuts ? esc(cuts.amount) : i.unit === 'piece' ? `${i.packQuantity} ${esc(packLabel(i))}` : i.target !== null ? `${i.target} g cocidos` : 'falta registrar lote'}</strong></p><label>${cuts ? 'Pedazos cortados empacados' : i.unit === 'piece' ? `Cantidad empacada · ${esc(packLabel(i))}` : 'Peso cocido neto empacado · g'}<input name="actual${n}" type="number" min="${cuts ? cuts.min : '0.000001'}" max="${cuts ? cuts.max : '100000000'}" step="${cuts ? '1' : 'any'}" required></label><label class="check"><input name="check${n}" type="checkbox" required>Ingrediente comprobado.</label>`}</div>`;
    }).join('')}${bag.includesSauce ? '<label class="check"><input name="sauceChecked" type="checkbox" required>Incluí la salsa de la casa.</label>' : ''}${bag.heat && bag.heat !== 'Suave' ? `<label class="check"><input name="heatChecked" type="checkbox" required>Comprobé picante ${esc(bag.heat)}.</label>` : ''}<label class="check"><input name="labelChecked" type="checkbox" required>Comprobé referencia del pedido, salsa y adicionales.</label>`, f => mutate({ type: 'pack', foodOnly: true, bagKey: key, labelChecked: f.get('labelChecked') === 'on', sauceChecked: f.get('sauceChecked') === 'on', heatChecked: bag.heat === 'Suave' || f.get('heatChecked') === 'on', checks: foodRequirements.map((i, n) => ({ ingredientId: i.id, ...(packingCountPlan(i,bag.lines,definitions)?{countedPieces:Number(f.get(`count${n}`))}:{}), confirmed: f.get(`check${n}`) === 'on', actual: i.method === 'portion' ? null : packingActual(i, bag.lines, definitions, f.get(`actual${n}`)) })) }), 'Guardar comprobación');
  }
}
$('.tabs').addEventListener('click', e => {
  const button = e.target.closest('[data-tab]'); if (!button) return;
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.id !== button.dataset.tab);
});
document.addEventListener('change', e => { if(e.target.id==='dispatch-mode'){const mode=e.target.value;if(busy)return;busy=true;e.target.disabled=true;api('routes/plan',{date:selected.document.date,mode,expectedGroups:selected.document.packingRoutes}).then(()=>api('runs/'+selected.document.id)).then(r=>{selected=r;packRoute=null;packMode='batch';renderPack();msg('Plan guardado en Empacar y Rutas.');}).catch(error=>{msg(error.message,true);renderPack();}).finally(()=>{busy=false;});return;} if (e.target.id === 'prep-batch' || e.target.matches('[data-service-period]')) { prepBatchId = e.target.value; packRoute=null;activePackOrderId=null;packSearchQuery='';packMode='batch';renderPreparation();renderComboOverview();renderOrders();renderPack(); e.target.blur(); refresh(); } if (e.target.id === 'pack-order-select') { packMode='single';activePackOrderId = e.target.value; renderPack(); } });
document.addEventListener('click', e => {
  if (e.target.closest('#print-prep')) { printPreparation(); return; }
  const close = e.target.closest('.close'); if (close) close.closest('dialog').close();
  const remove = e.target.closest('.remove'); if (remove) { const inOrder = remove.closest('#order-form'); remove.parentElement.remove(); if (inOrder) saveDraft(); }
  const button = e.target.closest('[data-command]'); if (button) command(button);
});
$('#run-select').addEventListener('change', async e => { await selectKitchenRun(e.target.value); e.target.blur(); });
$('#refresh').addEventListener('click', () => refresh({force:true}));
$('#new-run').addEventListener('click', () => openDialog('#run-dialog'));
$('#add-component').addEventListener('click', () => componentRow());
$('#add-line').addEventListener('click', () => { lineRow(); saveDraft(); });
$('#order-form').addEventListener('input', saveDraft);
$('#order-form').addEventListener('change', saveDraft);
$('#print').addEventListener('click', async () => { try { if (!selected) throw new Error('Selecciona una jornada para imprimir.'); selected = await api(`runs/${selected.document.id}`); render(); if (selected.document.sync?.issues.length || selected.document.needsSourceReview) throw new Error('Resuelve la revisión de WhatsApp antes de imprimir.'); window.print(); } catch(error) { msg(error.message,true); } });
$('#logout').addEventListener('click', async () => { await fetch('/api/session', { method: 'DELETE' }); location.href = '/login'; });
bindForm('#run-form', async (f, form) => {
  selected = await api('runs', { date: f.get('date'), startsAt:f.get('startsAt'), endsAt:f.get('endsAt'), capacity: Number(f.get('capacity')), opensAt: `${f.get('opensAt')}:00-05:00`, cutoff: `${f.get('cutoff')}:00-05:00` });
  runs = await api('runs'); form.closest('dialog').close(); render(); msg('Jornada creada.');
});
bindForm('#ingredient-form', async (f, form) => {
  const value = Object.fromEntries(f); value.id ||= crypto.randomUUID(); value.packFactor = Number(value.packFactor); value.screening = value.minGrams || value.maxGrams ? { minGrams: Number(value.minGrams), maxGrams: Number(value.maxGrams) } : null; delete value.minGrams; delete value.maxGrams;
  const document = structuredClone(catalog.document), index = document.ingredients.findIndex(i => i.id === value.id);
  if (index >= 0) document.ingredients[index] = value; else document.ingredients.push(value);
  catalog = await api('catalog', { version: Number(form.dataset.version), document }, 'PUT');
  form.closest('dialog').close(); renderMenu(); msg('Ingrediente guardado. Los pedidos existentes conservan su definición anterior.');
});
bindForm('#product-form', async (f, form) => {
  const value = { id: f.get('id') || crypto.randomUUID(), name: f.get('name'), unit: f.get('unit'), baseQuantity: Number(f.get('baseQuantity')), priceCop: Number(f.get('priceCop')), description: f.get('description'), requiresHeat: f.get('requiresHeat') === 'on', includesSauce: f.get('includesSauce') === 'on', components: [...document.querySelectorAll('#components .ingredient-row')].map(r => ({ ingredientId: r.querySelector('.component-id').value, quantity: Number(r.querySelector('.component-quantity').value) })) };
  const catalogDoc = structuredClone(catalog.document), index = catalogDoc.products.findIndex(p => p.id === value.id);
  if (index >= 0) catalogDoc.products[index] = value; else catalogDoc.products.push(value);
  catalog = await api('catalog', { version: Number(form.dataset.version), document: catalogDoc }, 'PUT'); form.closest('dialog').close(); render(); msg('Producto guardado. Los pedidos existentes conservan su precio y receta.');
});
bindForm('#order-form', async (_f, form) => {
  const key = `kitchen-order-${selected.document.id}`; await mutate({ type: 'addOrder', order: readOrder() });
  try { sessionStorage.removeItem(key); } catch { /* successful server save is authoritative */ }
  form.closest('dialog').close(); form.reset();
});
bindForm('#action-form', async (f, form) => { await actionHandler(f); form.closest('dialog').close(); });
await refresh();
// Shared links open one saved packing slot; later refreshes preserve the user's selection.
const packingLink = new URLSearchParams(location.search);
if (packingLink.get('batch')) {
  const linkedRun = runs.find(r => r.date === packingLink.get('date'));
  if (linkedRun && selected?.document.id !== linkedRun.id) await selectKitchenRun(linkedRun.id);
  const linkedBatch = selected?.document.packingBatches?.find(b => b.id === packingLink.get('batch'));
  if (linkedBatch) {
    prepBatchId = linkedBatch.periodId;
    packRoute = 'batch:' + linkedBatch.id;
    packMode = 'batch';
    renderPreparation(); renderComboOverview(); renderOrders(); renderPack();
    document.querySelector('[data-tab="pack"]').click();
  }
}
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
window.addEventListener('focus', refresh);

document.addEventListener('submit',async e=>{if(e.target.id!=='rider-count-form')return;e.preventDefault();const form=e.target,button=form.querySelector('button');if(busy)return;busy=true;button.disabled=true;try{await api('routes/riders',{date:selected.document.date,count:Number(new FormData(form).get('count'))});selected=await api('runs/'+selected.document.id);packRoute=null;render();msg('Rutas guardadas para todos los dispositivos.');}catch(error){msg(error.message);button.disabled=false;}finally{busy=false;}});
