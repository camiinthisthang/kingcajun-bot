import {savedDeliveryRequests} from './delivery-instructions.js?v=request-filters-20261023';
import {servicePeriods,matchesServicePeriod} from './service-periods.js?v=friday-periods-20261022-2';
import {currentWeek,shiftDate,periodLabel} from './reporting-period.js';
import {initFinances} from './finances.js';
import {savedDispatchLocation,pointMapsLink} from './location-utils.js';
import {deliveryDay,displayAddress,filteredOrders,fulfillment,mapEligible,readyDelivery} from './operations-view.js?v=20261013-location-reminders';
import {DeliveryMap} from './delivery-map.js?v=routes-estimates-20261024';
import {LocationEditor} from './location-editor.js?v=20261013-location-reminders';
import {paymentGroups,paymentGroup,paymentView} from './payment-view.js?v=20261013-payments';
import {orderMix} from './order-mix.js?v=20261014-order-mix';
import {canRefreshDashboard,startDashboardRefresh} from './dashboard-refresh.js?v=20261016-live-payments';
const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('es-CO');
const shortDate = new Intl.DateTimeFormat('es-CO', { month: 'short', day: 'numeric', timeZone: 'America/Bogota' });
const fullDate = new Intl.DateTimeFormat('es-CO', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
const statusLabels = { awaiting_payment: 'Pendiente de pago · sin confirmar', delivery_review: 'Pendiente de coordinar · sin confirmar', confirmed: 'Confirmado', payment_review: 'Revisión de pago · sin confirmar', expired: 'Expirado', cancelled: 'Cancelado', fulfilled: 'Entregado' };
let snapshot = null;
let waitlist = [];
let selectedDay = "";
let selectedServicePeriod = "";
const locationEditor = new LocationEditor({api,onRefresh:async publicId=>{if(!await loadDashboard())throw new Error('No se pudo actualizar. Tu borrador sigue aquí.');return snapshot?.orders.find(o=>o.public_id===publicId);},onSaved:({publicId,location})=>{
  const order=snapshot?.orders.find(o=>o.public_id===publicId);
  if(order)order.delivery_coverage={...order.delivery_coverage,dispatchLocation:location};
  renderOperations();toast('Ubicación guardada para este pedido.');
}});
function resolveOrderLocation(publicId){const order=snapshot?.orders.find(o=>o.public_id===publicId);if(order)locationEditor.open(order);}
const deliveryMap = new DeliveryMap(resolveOrderLocation);
$('#orders-body').addEventListener('click',event=>{const button=event.target.closest('[data-resolve-location]');if(button)resolveOrderLocation(button.dataset.resolveLocation);});
let windowsLoaded = false;
let editingCodeId = null;
let latestLoad = 0;
let activeLoads = 0;

let homePeriod='week';
function setWeek(week=currentWeek()){ $('#filter-from').value=week.from;$('#filter-to').value=week.to;homePeriod='week';}
setWeek();homePeriod='current';

async function api(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  if (response.status === 401) { location.href = '/login'; throw new Error('Sesión vencida'); }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'No se pudo completar la operación');
  return body.data ?? body;
}

function queryString() {
  const params = new URLSearchParams({basis:'delivery'});
  if ($('#filter-from').value) params.set('from', $('#filter-from').value);
  if ($('#filter-to').value) params.set('to', $('#filter-to').value);
  if ($('#filter-window').value) params.set('window', $('#filter-window').value);
  if ($('#filter-status').value) params.set('status', $('#filter-status').value);
  return params.toString();
}

async function loadDashboard({background=false} = {}) {
  if(homePeriod==='current'){const week=currentWeek();if($('#filter-from').value!==week.from){selectedDay='';$('#filter-window').value='';}setWeek(week);homePeriod='current';}
  if($('#filter-from').value&&$('#filter-to').value&&$('#filter-from').value>$('#filter-to').value){toast('La fecha inicial debe ser anterior a la final.');return;}
  $('#week-label').textContent=periodLabel($('#filter-from').value,$('#filter-to').value);
  const loadId = ++latestLoad;
  activeLoads++;
  if(!background) $('#sync-label').textContent = 'Consultando fuente';
  try {
    const [data,list] = await Promise.all([api(`/api/admin/dashboard?${queryString()}`),api("/api/admin/waitlist")]);
    if (loadId !== latestLoad) return;
    // An editor may have opened while the request was in flight.
    if(background && !canRefreshDashboard(document)) return;
    const changed = JSON.stringify([data,list]) !== JSON.stringify([snapshot,waitlist]);
    snapshot = data;waitlist=list;
    if(!background || changed) render(snapshot);
    $('#sync-label').textContent = 'Sincronizado';
    $('#sync-time').textContent = `Actualizado ${new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
    return data;
  } catch (error) {
    if (loadId !== latestLoad) return;
    $('#sync-label').textContent = 'Error de conexión';
    toast(error.message);
  } finally { activeLoads--; }
}

function render(data) {
  renderWindowOptions(data.filters.windows.filter(w=>inHomePeriod(deliveryDay(w))));
  renderTruth(data.source);
  renderKpis(data.kpis,data.payment_orders||[]);
  renderChart(data.daily.map(row=>({...row,revenue_cop:(data.payment_orders||[]).filter(o=>deliveryDay(o)===row.day).reduce((n,o)=>n+(o.net_collected_cop??o.collected_cop),0)})));
  renderStatuses(data.statuses);
  renderDayOptions(data);
  renderOperations();
  renderStaffConfirmations(data.staff_confirmations || []);
  renderMarketing(data);
  renderGoals(data.goals, data.active_goal);
}

function renderWindowOptions(windows) {
  const current = $('#filter-window').value;
  $('#filter-window').innerHTML = '<option value="">Todas las franjas</option>' + servicePeriods(windows).map(period => `<option value="${escapeHtml(period.windowIds.join(','))}">${shortDate.format(new Date(period.startsAt))} · ${escapeHtml(period.label)}</option>`).join('');
  $('#filter-window').value = current;
  windowsLoaded = true;
}

function renderTruth(source) {
  const demo = source.demo_seeded ? '<strong>Modo demostración activo.</strong> Los ejemplos fueron creados por el mismo servicio de pedidos y pagos del bot.' : '<strong>Datos operativos en vivo.</strong> Pedidos, pagos y referidos vienen de la misma base del bot de WhatsApp.';
  $('#truth-note').innerHTML = `<span class="shield">✓</span><span>${demo}</span>`;
}

function renderKpis(kpi,orders) {
  $('#kpi-orders').textContent=number.format(kpi.orders_count);
  $('#kpi-orders-note').textContent=`${number.format(kpi.paid_orders_count)} pagados por completo`;
  $('#kpi-pending').textContent=number.format(kpi.pending_requests_count);
}

function renderChart(rows) {
  const canvas = $('#revenue-chart');
  if (!canvas) return;
  const empty = $('#chart-empty');
  const values = rows.filter((row) => row.revenue_cop > 0);
  if (!values.length) { canvas.style.display = 'none'; empty.style.display = 'grid'; return; }
  canvas.style.display = 'block'; empty.style.display = 'none';
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 24 || rect.height <= 51) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height, pad = { left: 12, right: 12, top: 15, bottom: 28 };
  const max = Math.max(...rows.map((row) => row.revenue_cop), 1);
  const slot = (width - pad.left - pad.right) / Math.max(rows.length, 1);
  ctx.strokeStyle = '#e7e3db'; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const y = pad.top + i * ((height - pad.top - pad.bottom) / 3); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); }
  rows.forEach((row, index) => {
    const barHeight = (row.revenue_cop / max) * (height - pad.top - pad.bottom - 8);
    const barWidth = Math.min(30, slot * .48);
    const x = pad.left + index * slot + (slot - barWidth) / 2;
    const y = height - pad.bottom - barHeight;
    ctx.fillStyle = '#e14d24'; roundRect(ctx, x, y, barWidth, barHeight, 5); ctx.fill();
    if (rows.length <= 12 || index % Math.ceil(rows.length / 10) === 0) { ctx.fillStyle = '#7b847e'; ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.fillText(shortDate.format(new Date(`${row.day}T12:00:00-05:00`)), x + barWidth / 2, height - 9); }
  });
}

function roundRect(ctx, x, y, width, height, radius) { const r = Math.min(radius, width / 2, height / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + width, y, x + width, y + height, r); ctx.arcTo(x + width, y + height, x, y + height, r); ctx.arcTo(x, y + height, x, y, r); ctx.arcTo(x, y, x + width, y, r); ctx.closePath(); }

function renderStatuses(rows) {
  const total = rows.reduce((sum, row) => sum + row.orders_count, 0) || 1;
  $('#status-list').innerHTML = rows.length ? rows.map((row) => `<div><div class="status-row-top"><span>${statusLabels[row.status] || row.status}</span><strong>${number.format(row.orders_count)}</strong></div><div class="status-bar"><span style="width:${(row.orders_count / total) * 100}%"></span></div></div>`).join('') : '<div class="empty-state" style="display:grid;position:static;height:130px">No hay pedidos con estos filtros.</div>';
}

function paymentReviewNotice(order) {
  const review=order.payment_verification;
  if(review?.status!=='pending')return '';
  const amount=Number(review.amountCop);
  return `<span class="status-badge payment_review">Comprobante por verificar</span><small style="display:block">${Number.isSafeInteger(amount)&&amount>0?escapeHtml(money.format(amount))+' · ':''}${escapeHtml(review.reason||'Pago pendiente de verificación')}</small>`;
}

function renderOrders(rows) {
  $('#order-count').textContent = `${number.format(rows.length)} registro${rows.length === 1 ? '' : 's'}${rows.length === 100 ? ' · últimos 100' : ''}`;
  $('#orders-body').innerHTML = rows.length ? rows.map((order) => `<tr><td><span class="order-id">${escapeHtml(order.public_id)}</span>${mapEligible(order)?`<button type="button" class="table-action" data-resolve-location="${escapeHtml(order.public_id)}">${savedDispatchLocation(order)?'Editar ubicación':'Resolver ubicación'}</button>${savedDispatchLocation(order)?`<a class="table-action" href="${escapeHtml(pointMapsLink(savedDispatchLocation(order)))}" target="_blank" rel="noopener">Ubicación verificada ↗</a>`:''}`:''}</td><td class="customer-cell"><strong>${escapeHtml(customerLabel(order))}</strong><small>${maskPhone(order.phone_e164)}</small>${(order.delivery_coverage?.contactPhones||[]).map(p=>`<a class="contact-phone" href="tel:${escapeHtml(p)}">${escapeHtml(p)}</a>`).join('')}${order.chat_manual_paused?'<small>Atención manual · IA pausada hasta SIGUE o CONFIRMA</small>':order.chat_paused_until?`<small>IA pausada hasta ${fullDate.format(new Date(order.chat_paused_until))}</small>`:``}</td><td class="location-cell">${escapeHtml(displayAddress(order))}</td><td class="window-cell"><strong>${order.delivery_coverage?.method==='pickup'?'Recogida':order.delivery_coverage?.method==='own_courier'?'Mensajero propio':order.fulfillment_type === 'delivery' ? 'Entrega' : 'Recoger'}</strong><small>${fullDate.format(new Date(order.starts_at))}</small>${deliveryRequest(order)?`<p class="delivery-request-inline">${escapeHtml(deliveryRequest(order))}</p>`:''}</td><td><span class="status-badge ${order.status}">${order.delivery_coverage?.needsReview && ['confirmed','awaiting_payment'].includes(order.status)?'Entrega por coordinar':statusLabels[order.status] || order.status}</span>${order.full_payment_required?'<small>Pago completo para confirmar</small>':''}${order.delivery_coverage?.checkoutReview?.status==='pending'?`<details class="checkout-review"><summary>⚑ Revisar pedido</summary>${order.delivery_coverage.checkoutReview.notes.map(n=>`<p>${escapeHtml(n)}</p>`).join('')}</details>`:''}${order.delivery_coverage?.locationConfirmation?.status==='needs_correction'?'<small>Cliente solicita corregir ubicación</small>':''}${reminderSummary(order)}${order.delivery_coverage?.needsReview ? `<button class="table-action" type="button" data-coverage="${escapeHtml(order.public_id)}">Revisar entrega</button>` : ""}</td><td>${order.referral_code ? `<span class="code-chip">${escapeHtml(order.referral_code)}</span>` : '—'}</td><td>${order.payment_status === 'partial' ? `<span class="status-badge confirmed">Abono: ${money.format(order.collected_cop)}</span><small>Saldo: ${money.format(order.balance_due_cop)}</small>` : order.payment_status === 'confirmed' ? '<span class="status-badge confirmed">Cobrado</span>' : `<span class="status-badge ${order.payment_status === 'amount_mismatch' ? 'payment_review' : 'awaiting_payment'}">${order.payment_status === 'amount_mismatch' ? 'Revisar' : 'Pendiente'}</span>`}${paymentReviewNotice(order)}${!order.delivery_coverage?.needsReview && order.payment_provider === 'manual_transfer' && order.status === 'awaiting_payment' ? `<button class="button secondary" type="button" data-transfer="${escapeHtml(order.public_id)}">Verificar transferencia</button>` : ''}${!order.delivery_coverage?.needsReview&&['confirmed','fulfilled'].includes(order.status)&&order.balance_due_cop>0?`<button class="button secondary" type="button" data-collect="${escapeHtml(order.public_id)}">Registrar cobro</button>`:''}</td><td class="numeric">${money.format(order.subtotal_cop)}<small style="display:block;color:#67736b">Domicilio: ${money.format(order.delivery_fee_cop)}</small></td><td class="numeric">${money.format(order.discount_cop)}</td><td class="numeric"><strong>${money.format(order.total_cop)}</strong></td><td class="numeric">${order.estimated_profit_cop == null ? '<span title="Faltan costos o pago confirmado">—</span>' : money.format(order.estimated_profit_cop)}</td></tr>`).join('') : '<tr class="loading"><td colspan="11">No hay pedidos para mostrar.</td></tr>';
}


function inHomePeriod(day){return (!$('#filter-from').value||day>=$('#filter-from').value)&&(!$('#filter-to').value||day<=$('#filter-to').value);}
function renderDayOptions(data) {
  const days=[...new Set([...data.orders.map(deliveryDay),...(data.payment_orders||[]).map(deliveryDay),...data.filters.windows.map(deliveryDay)])].filter(day=>day&&inHomePeriod(day)).sort();
  const label=day=>new Intl.DateTimeFormat('es-CO',{weekday:'long',day:'numeric',month:'short',timeZone:'America/Bogota'}).format(new Date(day+'T12:00:00-05:00'));
  $('#delivery-days').innerHTML=[{day:'',label:'Todos los días'},...days.map(day=>({day,label:label(day)}))].map(({day,label})=>`<button type="button" class="day-tab ${day===selectedDay?'selected':''}" data-day="${escapeHtml(day)}" aria-pressed="${day===selectedDay}">${escapeHtml(label)}<span>${filteredOrders(data.orders,{day,scope:$('#order-scope').value}).length}</span></button>`).join('');
  $('#order-mix-day').innerHTML='<option value="">Todos los días</option>'+days.map(day=>`<option value="${escapeHtml(day)}">${escapeHtml(label(day))}</option>`).join('');
  $('#order-mix-day').value=selectedDay;
}
function deliveryRequest(order) {
  return savedDeliveryRequests(order).join('\n');
}
function customerLabel(order) {
  const name=(order.display_name||'').trim();
  return /[\p{L}\p{N}]/u.test(name)?name:(order.delivery_coverage?.contactPhones?.[0]||order.phone_e164||'Cliente sin nombre');
}
function renderDeliveryRequests(rows) {
  const requests=rows.filter(o=>deliveryRequest(o));
  const panel=$('#delivery-requests');panel.hidden=false;
  panel.innerHTML=requests.length?`<h3>Horarios y solicitudes de entrega</h3><p>Solo los pedidos de los filtros actuales. Tenlos en cuenta al organizar la ruta.</p><div class="delivery-request-list">${requests.map(o=>`<article><strong>${escapeHtml(customerLabel(o))}</strong><span>${escapeHtml(shortDate.format(new Date(o.starts_at)))}</span><p>${escapeHtml(deliveryRequest(o))}</p><small>${escapeHtml(displayAddress(o))}</small><small>Referencia: ${escapeHtml(o.public_id)}</small></article>`).join('')}</div>`:'<h3>Horarios y solicitudes de entrega</h3><p>No hay solicitudes de horario o entrega registradas para los pedidos de estos filtros.</p>';
}
function renderOperations() {
  renderWaitlist();
  if(!snapshot)return;
  renderOrderMix();
  const periods=servicePeriods(snapshot.filters.windows.filter(w=>deliveryDay(w)===selectedDay));
  if(!periods.some(p=>p.id===selectedServicePeriod))selectedServicePeriod='';
  const period=periods.find(p=>p.id===selectedServicePeriod);
  const periodTabs=$('#delivery-periods');periodTabs.hidden=!selectedDay;
  periodTabs.innerHTML=[{id:'',label:'Toda la jornada'},...periods].map(p=>`<button type="button" class="day-tab ${p.id===selectedServicePeriod?'selected':''}" data-period="${escapeHtml(p.id)}" aria-pressed="${p.id===selectedServicePeriod}">${escapeHtml(p.label)}<span>${filteredOrders(snapshot.orders,{day:selectedDay,scope:$('#order-scope').value}).filter(o=>matchesServicePeriod(o,p.windowIds?p:null)).length}</span></button>`).join('');
  const rows=filteredOrders(snapshot.orders.filter(o=>matchesServicePeriod(o,period)),{scope:$('#order-scope').value,day:selectedDay,search:$('#order-search').value,method:$('#order-method').value,sort:$('#order-sort').value});
  renderOrders(rows);
  renderDeliveryRequests(rows);
  const pickups=rows.filter(o=>['pickup','own_courier'].includes(fulfillment(o))&&!['cancelled','expired'].includes(o.status)).length;
  const deliveries=rows.filter(mapEligible),confirmed=deliveries.filter(readyDelivery).length;
  $('#operations-summary').textContent=`${period?period.label+' · ':''}${rows.length} registros · ${confirmed} domicilios confirmados · ${deliveries.length-confirmed} domicilios pendientes · ${pickups} pickup${snapshot.orders.length===100?' · Vista limitada a los 100 más recientes del periodo; acota Desde/Hasta o Franja para ver el resto.':''}`;
  deliveryMap.render(rows);
}
function renderOrderMix() {
  const mix=orderMix(snapshot.payment_orders||[],{day:selectedDay});
  $('#order-mix-total').textContent=`${number.format(mix.total)} ${mix.total===1?'pedido confirmado':'pedidos confirmados'}`;
  $('#order-mix-cards').innerHTML=mix.groups.map(g=>`<div class="order-mix-card"><span>${escapeHtml(g.label)}</span><strong>${number.format(g.count)}</strong><div class="order-mix-bar" aria-hidden="true"><i style="width:${g.percent}%"></i></div><small>${number.format(Math.round(g.percent))}% del total</small></div>`).join('');
  const mixed=mix.groups.some(g=>g.id==='mixed');
  $('#order-mix-note').textContent=`Cada pedido cuenta una vez. Los combos con adicionales siguen contando como combos.${mixed?' Si incluye combos distintos, aparece en «Combos variados».':''}${mix.pending?` ${number.format(mix.pending)} ${mix.pending===1?'solicitud sin confirmar queda fuera':'solicitudes sin confirmar quedan fuera'}.`:''}${mix.total?'':' No hay pedidos confirmados para esta selección.'}`;
}
$('#order-mix-day').addEventListener('change',()=>{selectedDay=$('#order-mix-day').value;if(snapshot){renderDayOptions(snapshot);renderOperations();}});
$('#delivery-periods').addEventListener('click',event=>{const button=event.target.closest('[data-period]');if(!button)return;selectedServicePeriod=button.dataset.period;renderOperations();});
$('#delivery-days').addEventListener('click',event=>{const button=event.target.closest('[data-day]');if(!button)return;selectedDay=button.dataset.day;renderDayOptions(snapshot);renderOperations();});
$('#order-search').addEventListener('input',renderOperations);
$('#order-method').addEventListener('change',renderOperations);
$('#order-scope').addEventListener('change',()=>{renderDayOptions(snapshot);renderOperations();});
$('#order-sort').addEventListener('change',renderOperations);
$('#map-retry').addEventListener('click',renderOperations);



function reminderSummary(order) {
  if(order.cancellation_reason)return `<small>${escapeHtml(order.cancellation_reason)}${order.refund_status==='pending'?' · Revisar devolución de dinero recibido':''}</small>`;
  if(!order.reminder_confirmation_required)return '';
  return (order.reminders || []).map(r=>{
    const label=r.kind==='reminder_24h'?'24 h':'6 h';
    const state=r.confirmed_at?'Confirmado':r.kind==='reminder_24h'&&r.deadline_at?`Sin respuesta: seguimiento desde ${fullDate.format(new Date(r.deadline_at))}`:r.status==='sent'?(r.delivered_at?'Pendiente de confirmación':'Esperando entrega del mensaje'):r.status==='pending'?'Programado':r.status==='cancelled'?'Cancelado':'Revisar envío';
    return `<small>${label}: ${escapeHtml(state)}</small>`;
  }).join('');
}

function renderStaffConfirmations(events) {
  $('#staff-confirmations').innerHTML=events.length?events.map(e=>`<details style="padding:12px 0;border-top:1px solid #e1e5e1"><summary><strong>${escapeHtml(e.display_name || maskPhone(e.customer_phone))}</strong> · ${e.outcome==='applied'?'Registrada':e.outcome==='paused'?'IA pausada hasta SIGUE':'Requiere revisión'}${e.public_id?' · '+escapeHtml(e.public_id):''}</summary><p>${escapeHtml(e.body)}</p><small>${fullDate.format(new Date(e.sent_at))} · ${escapeHtml(e.detail || '')}</small></details>`).join(''):'<p class="muted">Aún no se han recibido confirmaciones del equipo.</p>';
}

function renderMarketing(data) {
  const ranked = data.codes.filter((code) => code.revenue_cop > 0).sort((a, b) => (b.roi ?? b.revenue_cop) - (a.roi ?? a.revenue_cop));
  const winner = ranked[0];
  if (winner) { $('#winner-name').textContent = `${winner.code} · ${winner.influencer_name}`; $('#winner-detail').textContent = `${number.format(winner.attributed_orders)} pedidos · ${money.format(winner.revenue_cop)} cobrados${winner.roi == null ? ' · sin inversión asignada' : ` · ROI ${percent(winner.roi)}`}`; }
  else { $('#winner-name').textContent = 'Esperando pedidos atribuidos'; $('#winner-detail').textContent = 'Los primeros códigos aparecerán aquí automáticamente.'; }

  $('#influencer-grid').innerHTML = data.influencers.length ? data.influencers.map((item) => `<article class="influencer-card"><div class="influencer-head"><span class="avatar">${initials(item.name)}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.platform || 'Código de referido')} ${item.handle ? '· ' + escapeHtml(item.handle) : ''}</small></div></div><div class="influencer-stats"><div><span>Pedidos</span><strong>${number.format(item.orders)}</strong></div><div><span>Ingresos</span><strong>${compactMoney(item.revenue_cop)}</strong></div><div><span>ROI</span><strong class="${item.roi >= 0 ? 'roi-positive' : 'roi-negative'}">${item.roi == null ? '—' : percent(item.roi)}</strong></div></div></article>`).join('') : '<article class="influencer-card">Aún no hay influencers configurados.</article>';

  $('#codes-body').innerHTML = data.codes.length ? data.codes.map((code, index) => `<tr><td><span class="code-chip">${escapeHtml(code.code)}</span>${index === 0 && code.revenue_cop > 0 ? ' <span title="Mejor señal">★</span>' : ''}${code.free_delivery?'<small>Domicilio gratis</small>':''}${code.active ? '' : '<span class="inactive-tag">Inactivo</span>'}</td><td>${escapeHtml(code.influencer_name)}</td><td>${code.content_url ? `<a class="content-link" href="${safeUrl(code.content_url)}" target="_blank" rel="noopener">${escapeHtml(code.campaign_name || 'Ver pieza')} ↗</a>` : escapeHtml(code.campaign_name || 'Sin pieza enlazada')}</td><td class="numeric">${number.format(code.attributed_orders)}</td><td class="numeric">${money.format(code.revenue_cop)}</td><td class="numeric">${money.format(code.spend_cop)}</td><td class="numeric"><strong class="${code.roi >= 0 ? 'roi-positive' : 'roi-negative'}">${code.roi == null ? '—' : percent(code.roi)}</strong></td><td class="numeric"><button class="table-action" type="button" data-edit-code="${escapeHtml(code.id)}">Editar</button></td></tr>`).join('') : '<tr class="loading"><td colspan="8">Aún no hay códigos.</td></tr>';

  $('#spend-body').innerHTML = data.spends.length ? data.spends.map((spend) => `<tr><td>${shortDate.format(new Date(spend.spent_at))}</td><td><strong>${escapeHtml(spend.campaign_name)}</strong></td><td>${escapeHtml(spend.influencer_name || '—')}</td><td>${spend.referral_code ? `<span class="code-chip">${escapeHtml(spend.referral_code)}</span>` : '—'}</td><td>${escapeHtml(spend.notes || '—')}</td><td class="numeric"><strong>${money.format(spend.amount_cop)}</strong></td></tr>`).join('') : '<tr class="loading"><td colspan="6">No hay inversión registrada en este periodo.</td></tr>';

  $('#spend-influencer').innerHTML = '<option value="">Sin influencer</option>' + data.influencers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  $('#spend-code').innerHTML = '<option value="">Sin código específico</option>' + data.codes.map((code) => `<option value="${escapeHtml(code.id)}" data-influencer="${escapeHtml(code.influencer_id || '')}">${escapeHtml(code.code)} · ${escapeHtml(code.influencer_name)}</option>`).join('');
  document.querySelectorAll('[data-edit-code]').forEach((button) => button.addEventListener('click', () => openReferral(button.dataset.editCode)));
}

function referralCreatorOptions(selectedId = '') {
  const options = snapshot.influencers.map((creator) => `<option value="${escapeHtml(creator.id)}" ${creator.id === selectedId ? 'selected' : ''}>${escapeHtml(creator.name)}${creator.handle ? ` · ${escapeHtml(creator.handle)}` : ''}</option>`).join('');
  return `<option value="__new__">+ Crear nuevo creador</option>${options}`;
}

function setCreatorMode() {
  const isNew = $('#referral-influencer').value === '__new__';
  $('#new-creator-fields').hidden = !isNew;
  const name = $('#referral-form').elements.creatorName;
  name.required = isNew;
}

function openReferral(codeId = null) {
  editingCodeId = codeId;
  const form = $('#referral-form');
  form.reset();
  $('#referral-error').textContent = '';
  $('#referral-history-note').hidden = !codeId;
  if (codeId) {
    const code = snapshot.codes.find((item) => item.id === codeId);
    $('#referral-title').textContent = `Editar ${code.code}`;
    $('#save-referral').textContent = 'Guardar cambios';
    $('#referral-influencer').innerHTML = referralCreatorOptions(code.influencer_id);
    $('#referral-influencer').value = code.influencer_id;
    $('#referral-influencer').querySelector('option[value="__new__"]').disabled = true;
    form.elements.code.value = code.code;
    form.elements.campaignName.value = code.campaign_name || '';
    form.elements.contentUrl.value = code.content_url || '';
    form.elements.validFrom.value = code.valid_from ? code.valid_from.slice(0, 10) : '';
    form.elements.validUntil.value = code.valid_until ? code.valid_until.slice(0, 10) : '';
    form.elements.active.checked = Boolean(code.active);
    form.elements.freeDelivery.checked = Boolean(code.free_delivery);
  } else {
    $('#referral-title').textContent = 'Crear código';
    $('#save-referral').textContent = 'Crear y asignar';
    $('#referral-influencer').innerHTML = referralCreatorOptions();
    $('#referral-influencer').value = snapshot.influencers[0]?.id || '__new__';
    form.elements.active.checked = true;
  }
  setCreatorMode();
  $('#referral-dialog').showModal();
}

function renderGoals(goals, activeKey) {
  $('#goals-track').innerHTML = goals.map((goal, index) => `<article class="goal-card ${goal.stage_key === activeKey ? 'active' : ''}"><span class="goal-number">0${index + 1}</span><span class="goal-date">${goal.target_date ? shortDate.format(new Date(`${goal.target_date}T12:00:00-05:00`)) : 'Sin fecha'}</span><h3>${escapeHtml(goal.label)}</h3><div class="goal-state">${goal.completed ? 'Completada' : goal.stage_key === activeKey ? 'Etapa actual' : 'Siguiente etapa'}</div><div class="goal-progress"><div class="goal-progress-line"><div><span>Pedidos cobrados</span><span>${Math.round(goal.order_progress * 100)}% · meta ${number.format(goal.order_target)}</span></div><div class="progress"><span style="width:${goal.order_progress * 100}%"></span></div></div><div class="goal-progress-line"><div><span>Ingresos</span><span>${Math.round(goal.revenue_progress * 100)}% · ${compactMoney(goal.revenue_target_cop)}</span></div><div class="progress"><span style="width:${goal.revenue_progress * 100}%"></span></div></div></div><button class="goal-edit" data-goal="${goal.stage_key}" type="button">Editar objetivo →</button></article>`).join('');
  document.querySelectorAll('[data-goal]').forEach((button) => button.addEventListener('click', () => openGoal(button.dataset.goal)));
}

function openGoal(stageKey) {
  const goal = snapshot.goals.find((item) => item.stage_key === stageKey);
  const form = $('#goal-form'); form.stageKey.value = goal.stage_key; form.orderTarget.value = goal.order_target; form.revenueTargetCop.value = goal.revenue_target_cop; form.targetDate.value = goal.target_date || ''; $('#goal-title').textContent = goal.label; $('#goal-error').textContent = ''; $('#goal-dialog').showModal();
}

for(const id of ['filter-from','filter-to'])$('#'+id).addEventListener('change',()=>{homePeriod='custom';selectedDay='';loadDashboard();}); $('#filter-window').addEventListener('change', loadDashboard); $('#filter-status').addEventListener('change',()=>{const status=$('#filter-status').value;const scope=['awaiting_payment','delivery_review','payment_review'].includes(status)?'pending':['confirmed','fulfilled',''].includes(status)?'confirmed':'all';$('#order-scope').value=scope;loadDashboard();});
$('#refresh-dashboard').addEventListener('click', loadDashboard);
$('#clear-filters').addEventListener('click', () => { setWeek();homePeriod='current'; $('#filter-window').value = ''; $('#filter-status').value = ''; selectedDay=''; $('#order-scope').value='confirmed'; $('#order-search').value=''; $('#order-method').value=''; loadDashboard(); });
$('#logout').addEventListener('click', async () => { await api('/api/session', { method: 'DELETE' }); location.href = '/login'; });
$('#open-referral').addEventListener('click', () => openReferral());
$('#referral-influencer').addEventListener('change', setCreatorMode);
$('#referral-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const isNewCreator = values.influencerId === '__new__';
  const payload = {
    code: values.code,
    influencerId: isNewCreator ? '' : values.influencerId,
    creatorName: isNewCreator ? values.creatorName : '',
    creatorHandle: isNewCreator ? values.creatorHandle : '',
    creatorPlatform: isNewCreator ? values.creatorPlatform : '',
    campaignName: values.campaignName,
    contentUrl: values.contentUrl,
    validFrom: values.validFrom,
    validUntil: values.validUntil,
    freeDelivery: form.elements.freeDelivery.checked, active: form.elements.active.checked
  };
  try {
    await api(editingCodeId ? `/api/admin/referral-codes/${editingCodeId}` : '/api/admin/referral-codes', { method: editingCodeId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('#referral-dialog').close();
    toast(editingCodeId ? 'Código actualizado' : 'Código creado y asignado');
    await loadDashboard();
  } catch (error) {
    const messages = { code_exists: 'Ese código ya existe. Elige uno diferente.', creator_name_exists: 'Ese creador ya existe. Selecciónalo en la lista.', invalid_code: 'Usa entre 3 y 24 letras, números, guiones o guion bajo.', invalid_dates: 'Revisa el rango de fechas.', invalid_url: 'El enlace debe comenzar con http:// o https://.', creator_not_found: 'No encontramos ese creador.' };
    $('#referral-error').textContent = messages[error.message] || 'No se pudo guardar el código.';
  }
});
$('#open-spend').addEventListener('click', () => { $('#spend-form').reset(); $('#spend-form').spentAt.value = new Date().toISOString().slice(0, 10); $('#spend-error').textContent = ''; $('#spend-dialog').showModal(); });
$('#spend-code').addEventListener('change', (event) => { const option = event.target.selectedOptions[0]; if (option?.dataset.influencer) $('#spend-influencer').value = option.dataset.influencer; });
$('#spend-form').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { await api('/api/admin/spend', { method: 'POST', body: JSON.stringify({ ...values, amountCop: Number(values.amountCop) }) }); $('#spend-dialog').close(); toast('Inversión guardada'); await loadDashboard(); } catch (error) { $('#spend-error').textContent = error.message; } });
$('#goal-form').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { await api(`/api/admin/goals/${values.stageKey}`, { method: 'PUT', body: JSON.stringify({ orderTarget: Number(values.orderTarget), revenueTargetCop: Number(values.revenueTargetCop), targetDate: values.targetDate }) }); $('#goal-dialog').close(); toast('Meta actualizada'); await loadDashboard(); } catch (error) { $('#goal-error').textContent = error.message; } });
window.addEventListener('resize', () => snapshot && renderChart(snapshot.daily.map(row=>({...row,revenue_cop:(snapshot.payment_orders||[]).filter(o=>deliveryDay(o)===row.day).reduce((n,o)=>n+(o.net_collected_cop??o.collected_cop),0)}))));

function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2600); }
function maskPhone(phone = '') { return phone.length > 6 ? `${phone.slice(0, 4)} ••• ${phone.slice(-4)}` : phone; }
function initials(value = '') { return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(); }
function percent(value) { return `${new Intl.NumberFormat('es-CO', { style: 'percent', maximumFractionDigits: 0 }).format(value)}`; }
function compactMoney(value) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? escapeHtml(url.href) : '#'; } catch { return '#'; } }

homePeriod='current';
$('#current-week').addEventListener('click',()=>$('#clear-filters').click());
for(const [id,offset] of [['previous-week',-7],['next-week',7]])$('#'+id).addEventListener('click',()=>{const from=$('#filter-from').value||currentWeek().from;setWeek({from:shiftDate(from,offset),to:shiftDate(from,offset+6)});selectedDay='';$('#filter-window').value='';loadDashboard();});
$('#all-history').addEventListener('click',()=>{homePeriod='all';$('#filter-from').value='';$('#filter-to').value='';selectedDay='';$('#filter-window').value='';loadDashboard();});
loadDashboard();
startDashboardRefresh(() => loadDashboard({background:true}), {isBusy:()=>activeLoads>0});

$('#orders-body').addEventListener('click', event => {
  const button=event.target.closest('[data-transfer]');if(!button)return;
  const order=snapshot.orders.find(o=>o.public_id===button.dataset.transfer);if(!order)return;
  const form=$('#transfer-form');form.reset();form.elements.publicId.value=order.public_id;
  $('#transfer-summary').textContent=`${order.public_id} · ${order.display_name || 'Cliente'} · Pago esperado: ${money.format(order.expected_payment_cop)} · Total del pedido: ${money.format(order.total_cop)}`;
  $('#transfer-error').textContent='';$('#transfer-dialog').showModal();
});
$('#transfer-form').addEventListener('submit',async event=>{
  if(event.submitter?.value==='cancel')return;event.preventDefault();const form=event.currentTarget,button=$('#confirm-transfer');button.disabled=true;
  try {await api(`/api/admin/orders/${encodeURIComponent(form.elements.publicId.value)}/confirm-transfer`,{method:'POST',body:JSON.stringify({amountCop:Number(form.elements.amountCop.value),bankReference:form.elements.bankReference.value,verified:form.elements.verified.checked})});$('#transfer-dialog').close();toast('Transferencia verificada. Pedido disponible en cocina.');await loadDashboard();}
  catch(error){$('#transfer-error').textContent=error.message;}finally{button.disabled=false;}
});

$('#orders-body').addEventListener('click', event => {
 const button=event.target.closest('[data-collect]');if(!button)return;
 const order=snapshot.orders.find(o=>o.public_id===button.dataset.collect);if(!order)return;
 const form=$('#collection-form');form.reset();form.elements.publicId.value=order.public_id;form.elements.amountCop.value=order.balance_due_cop;
 $('#collection-summary').textContent=`${order.public_id} · Total ${money.format(order.total_cop)} · Recibido ${money.format(order.collected_cop)} · Saldo ${money.format(order.balance_due_cop)}`;
 $('#collection-error').textContent='';$('#collection-dialog').showModal();
});
$('#collection-form').addEventListener('submit',async event=>{
 if(event.submitter?.value==='cancel')return;event.preventDefault();const form=event.currentTarget,button=$('#record-collection');button.disabled=true;
 try{await api(`/api/admin/orders/${encodeURIComponent(form.elements.publicId.value)}/collect-payment`,{method:'POST',body:JSON.stringify({amountCop:Number(form.elements.amountCop.value),receiptReference:form.elements.receiptReference.value,verified:form.elements.verified.checked})});$('#collection-dialog').close();toast('Cobro registrado.');await loadDashboard();}
 catch(error){$('#collection-error').textContent=error.message;}finally{button.disabled=false;}
});

function previewCoverageAgreement(){
 const form=$('#coverage-form'),order=snapshot.orders.find(o=>o.public_id===form.elements.publicId.value);if(!order)return;
 if(form.elements.method.value!=='delivery')form.elements.deliveryFeeCop.value=0;
 form.elements.deliveryFeeCop.readOnly=form.elements.method.value!=='delivery';
 const fee=Number(form.elements.deliveryFeeCop.value),total=order.subtotal_cop+(order.discount_cop>0?0:fee);
 $('#coverage-total').textContent=`Total acordado: ${money.format(total)}${order.discount_cop>0?' · Domicilio gratis por código':''}. ${order.full_payment_required?'Pago completo requerido: '+money.format(total)+'; comparte los datos bancarios después de coordinar.':total>200000?'Abono requerido: $50.000; comparte los datos bancarios después de coordinar.':'Pago al recibir.'}`;
}
$('#orders-body').addEventListener('click',event=>{
 const button=event.target.closest('[data-coverage]');if(!button)return;
 const order=snapshot.orders.find(o=>o.public_id===button.dataset.coverage);if(!order)return;
 const form=$('#coverage-form');form.reset();form.elements.publicId.value=order.public_id;
 form.elements.method.value=['pickup','own_courier'].includes(order.delivery_coverage.preference)?order.delivery_coverage.preference:'delivery';
 form.elements.details.value=order.delivery_address;form.elements.deliveryFeeCop.value=order.delivery_fee_cop;
 $('#coverage-summary').textContent=`${order.public_id} · ${order.delivery_coverage.label} · ${order.phone_e164}`;
 $('#coverage-error').textContent='';previewCoverageAgreement();$('#coverage-dialog').showModal();
});
$('#coverage-form').addEventListener('input',previewCoverageAgreement);
$('#coverage-form').addEventListener('submit',async event=>{
 if(event.submitter?.value==='cancel')return;event.preventDefault();const form=event.currentTarget,button=$('#save-coverage');button.disabled=true;
 try{
  await api(`/api/admin/orders/${encodeURIComponent(form.elements.publicId.value)}/resolve-delivery`,{method:'POST',body:JSON.stringify({method:form.elements.method.value,details:form.elements.details.value,deliveryFeeCop:Number(form.elements.deliveryFeeCop.value),agreedWithCustomer:form.elements.agreedWithCustomer.checked})});
  $('#coverage-dialog').close();toast('Acuerdo guardado.');await loadDashboard();
 }catch(error){$('#coverage-error').textContent=error.message;}finally{button.disabled=false;}
});

function renderWaitlist() {
  const rows=waitlist.filter(row=>inHomePeriod(row.delivery_date)&&(!selectedDay||row.delivery_date===selectedDay));
  $('#waitlist-body').innerHTML=rows.length?rows.map(row=>`<tr><td><strong>${escapeHtml(row.display_name||'Cliente WhatsApp')}</strong><br>${/^\+[1-9]\d{7,14}$/.test(row.phone_e164)?`<a href="https://wa.me/${row.phone_e164.slice(1)}" target="_blank" rel="noopener">Abrir chat · ${escapeHtml(row.phone_e164)}</a>`:'Busca este usuario en WhatsApp Business'}</td><td>${fullDate.format(new Date(row.starts_at))}</td><td>${row.space_available?'Cupo disponible · consultar al cliente':'Sin cupo regular'}</td><td>${row.status==='contacted'?'Contactado':'En espera'}<br><small>Desde ${fullDate.format(new Date(row.consent_at))}</small></td><td><button class="table-action" data-waitlist-id="${escapeHtml(row.id)}" data-waitlist-status="${row.status==='contacted'?'waiting':'contacted'}">${row.status==='contacted'?'Volver a espera':'Marcar contactado'}</button><button class="table-action" data-waitlist-id="${escapeHtml(row.id)}" data-waitlist-status="withdrawn">Retirar</button></td></tr>`).join(''):'<tr><td colspan="5">No hay clientes en espera para esta selección.</td></tr>';
}
$('#waitlist-body').addEventListener('click',async event=>{
 const button=event.target.closest('[data-waitlist-id]');if(!button)return;button.disabled=true;
 try{await api(`/api/admin/waitlist/${encodeURIComponent(button.dataset.waitlistId)}`,{method:'PATCH',body:JSON.stringify({status:button.dataset.waitlistStatus})});await loadDashboard();toast('Lista de espera actualizada.');}
 catch(error){toast(error.message);button.disabled=false;}
});

function selectAdminView(){
 const key=location.hash.slice(1),special=['confirmations','marketing','goals','finances'].includes(key);
 if(key==='finances')financeView.load();
 $('h1').textContent=key==='finances'?'Finanzas de King Cajun.':'Esta semana en King Cajun.';
 $('.subtitle').textContent=key==='finances'?'Dinero recibido, gastos y movimientos registrados.':'Tomamos pedidos de lunes a viernes · entregamos de viernes a domingo.';
 $('#operations-home').hidden=special;
 if(!special&&snapshot)renderChart(snapshot.daily.map(row=>({...row,revenue_cop:(snapshot.payment_orders||[]).filter(o=>deliveryDay(o)===row.day).reduce((n,o)=>n+(o.net_collected_cop??o.collected_cop),0)})));
 document.querySelectorAll('.sidebar nav a').forEach(a=>a.classList.toggle('active',a.hash==='#'+(special?key:'overview')));
 for(const id of ['confirmations','marketing','goals','finances'])$('#'+id).hidden=id!==key;
 document.querySelectorAll('.admin-view-tabs a').forEach(a=>{if(a.hash==='#'+(special?key:'overview'))a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
}
const financeView=initFinances({root:$('#finances'),api,toast});
window.addEventListener('hashchange',selectAdminView);selectAdminView();
