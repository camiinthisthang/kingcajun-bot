const { readyForDevice, unseenReady, rememberReady, activateForegroundAudio, signalReady } = await import('./ready-alerts.js').catch(error => {
  document.querySelector('#connection').textContent = '● No se pudo iniciar';
  document.querySelector('#connection').classList.add('bad');
  const message = document.createElement('p');
  message.className = 'loading';
  message.textContent = 'No se pudo cargar la aplicación. Recarga la página para volver a intentar. Si continúa, avisa al administrador.';
  const retry = document.createElement('button');
  retry.textContent = 'Volver a intentar';
  retry.onclick = () => location.reload();
  document.querySelector('#app').replaceChildren(message, retry);
  throw error;
});
const $ = s => document.querySelector(s);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
const labels = { reserved:'Esperando confirmación', dispatched:'En camino', approved:'Cancelación aprobada', new: 'Recibida', cooking: 'Preparando', ready: 'Lista', served: 'Entregada', cancel_requested: 'Cancelar · pendiente', cancelled: 'Cancelada' };
const kitchen = location.pathname === '/mesas/cocina';
const deliveryView = new URLSearchParams(location.search).get('view') === 'delivery';
const can = role => !state?.workflow || state.actor?.roles?.includes(role);
const embedded = kitchen && new URLSearchParams(location.search).get('embedded') === '1';
if (embedded) document.body.classList.add('embedded-kitchen');
const time = s => new Date(s).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
let catalog, state, selected = 1, category = 'Combo', search = '', draft, product, cancelTicket, lastHash = '', refreshing = false, busy = false, mobileCart = false;
let tabId, storageOK = true, sound = false, audio, knownTickets = new Set(), firstLoad = true;
let deviceId, foregroundAudio, readySoundEnabled = false, pushActive = false, pushConfig, readySeen = new Set();
try { deviceId = localStorage.getItem('kc-dine-in:device') || crypto.randomUUID(); localStorage.setItem('kc-dine-in:device', deviceId); readySeen = new Set(JSON.parse(sessionStorage.getItem('kc-ready-seen') || '[]')); } catch { deviceId = crypto.randomUUID(); }
const requestedTable = Number(new URLSearchParams(location.search).get('table'));
if (requestedTable >= 1 && requestedTable <= 12 && Number.isInteger(requestedTable)) selected = requestedTable;
try { tabId = sessionStorage.getItem('kc-table-tab') || crypto.randomUUID(); sessionStorage.setItem('kc-table-tab', tabId); }
catch { tabId = crypto.randomUUID(); storageOK = false; }
const key = table => `kc-tables-live:v1:${tabId}:mesa:${table}`;
const memoryDrafts = new Map();
const activeVisit = table => state?.visits.find(v => v.table_no === table);
function readDraft(table) {
  let d = memoryDrafts.get(table);
  if (!d && storageOK) { try { d = JSON.parse(localStorage.getItem(key(table)) || 'null'); } catch { storageOK = false; } }
  return d || { table, visitId: activeVisit(table)?.id ?? null, waiter: '', notes: '', items: [], requestId: crypto.randomUUID(), pending: null };
}
function saveDraft() {
  memoryDrafts.set(selected, draft);
  try { if (!storageOK) throw Error(); localStorage.setItem(key(selected), JSON.stringify(draft)); }
  catch { storageOK = false; }
  const el = $('#save-status'); if (el) el.textContent = storageOK ? 'Borrador guardado en este navegador · aún no enviado' : 'Solo en pantalla: el navegador no permite guardar el borrador.';
}
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 7000); }
async function api(path, body) {
  let res;
  try { res = await fetch(path.replace(/^\/api\//, '/api/dine-in/'), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) } : { signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error('Sin respuesta. No sabemos si se recibió el envío; reintenta para verificar sin duplicarlo.'); }
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && !$('#session-warning')) {
      const warning = document.createElement('div'); warning.id = 'session-warning'; warning.className = 'retry-banner';
      warning.append('Tu sesión terminó. Conservamos el borrador. ');
      const link = document.createElement('a'); link.href = state?.workflow?'/mesas/login':'/login?next=mesas'; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Iniciar sesión en otra pestaña'; warning.append(link); document.body.prepend(warning);
    }
    const e = new Error(res.status === 401 ? 'Inicia sesión y vuelve a intentar. Tu borrador sigue aquí.' : data.error || 'No se pudo guardar.'); e.status = res.status; e.code = data.code; throw e;
  }
  $('#session-warning')?.remove();
  return data;
}
const total = items => items.reduce((n, i) => n + i.priceCop * i.quantity, 0);
function enriched(items) { return items.map(i => ({ ...catalog.items.find(p => p.id === i.productId), ...i })); }
const part = i => `${i.quantity} × ${i.name}${i.portion === '100 g' ? ' (cada unidad: 100 g)' : ''}`;
function lineList(items) {
  return `<ul class="ticket-items">${items.map(i => `<li><strong>${escape(part(i))}</strong>${i.heat ? `<small>Picante ${escape(i.heat)}</small>` : ''}${i.notes ? `<small class="item-note">↳ ${escape(i.notes)}</small>` : ''}</li>`).join('')}</ul>`;
}
function renderShell() {
  if(state.workflow){document.body.classList.add('onto-pos');$('#kitchen-link').href='/mesas/cocina';$('#identity').textContent=state.actor.name;$('#account-tools').hidden=false;$('#staff-settings').hidden=!state.actor.owner;}
  $('#staff-link').classList.toggle('active', !kitchen); $('#kitchen-link').classList.toggle('active', kitchen);
  document.title = `King Cajun · ${kitchen ? 'Cocina' : 'Mesas'}`;
  if (kitchen) {
    $('#app').innerHTML = `<div class="kitchen-heading"><div><span class="eyebrow">COMANDAS EN TIEMPO REAL</span><h1>En cocina</h1><p>Mesas y domicilios. Cada comanda conserva sus detalles.</p></div><button id="sound">Activar aviso sonoro</button></div><div id="board" class="board"></div><details class="history"><summary>Entregadas y canceladas · historial reciente</summary><div id="history" class="history-grid"></div></details>`;
    $('#sound').onclick = async () => { try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); sound = !sound; $('#sound').textContent = sound ? 'Aviso sonoro activado' : 'Activar aviso sonoro'; if (sound) beep(); } catch { toast('Este navegador no permitió activar el sonido.'); } };
    renderBoard(); return;
  }
  if(deliveryView){$('#app').innerHTML='<div class="main-heading"><div><span class="eyebrow">WHATSAPP</span><h1>Domicilios</h1><p>Confirmación, cocina, despacho y entrega.</p></div></div><div id="deliveries" class="history-grid"></div>';if(can('Manager'))$('#app').insertAdjacentHTML('afterbegin','<p style="margin-bottom:16px"><a href="/mesas/assets/slots.html">Administrar cupos de entrega →</a></p>');renderDeliveries();return;}
  draft = readDraft(selected);
  $('#app').innerHTML = `<div class="workspace"><aside class="tables-pane"><div class="tables-head"><span class="eyebrow">MESAS</span><span class="fine">12</span></div><div class="table-list" id="tables"></div><p class="legend">Los pedidos listos se resaltan para llevarlos a la mesa.</p></aside><section class="menu-pane"><div class="main-heading"><div><span class="eyebrow">TOMAR PEDIDO</span><h1 id="table-title"></h1><p>Elige un plato y ajusta los detalles.</p></div><button id="mobile-cart-top" class="cart-toggle">Ver comanda</button></div><input class="search" type="search" id="search" placeholder="Buscar en el menú" aria-label="Buscar en el menú"><div class="categories" id="categories"></div><div class="products" id="products"></div><section class="table-tickets"><h2>Ya enviado a cocina</h2><div id="table-tickets"></div></section></section><aside class="cart" id="cart"></aside></div><div id="mobile-bar" class="mobile-bar"></div>`;
  $('#search').oninput = e => { search = e.target.value; renderProducts(); };
  $('#mobile-cart-top').onclick = () => { mobileCart = true; setMobileView(); };
  renderTableSelection(); renderCategories(); renderProducts(); renderCart(); renderTableTickets();
}
function renderTableSelection() {
  $('#table-title').textContent = `Mesa ${selected}`;
  $('#tables').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1, visit = activeVisit(n), tickets = state.tickets.filter(t => t.visit_id === visit?.id), ready = tickets.some(t => t.state === 'ready');
    const saved = n === selected ? draft : readDraft(n), hasDraft = saved.items.length > 0;
    return `<button class="table ${n === selected ? 'selected' : ''} ${ready ? 'is-ready' : ''} ${hasDraft ? 'has-draft' : ''}" data-table="${n}" aria-label="Mesa ${n}" aria-pressed="${n === selected}">${n}<small>${ready ? 'Lista para llevar' : hasDraft ? 'Borrador' : visit ? 'En servicio' : 'Disponible'}</small></button>`;
  }).join('');
  document.querySelectorAll('[data-table]').forEach(el => el.onclick = () => { if (busy) return; saveDraft(); selected = Number(el.dataset.table); draft = readDraft(selected); mobileCart = false; renderTableSelection(); renderCart(); renderProducts(); renderTableTickets(); });
}
function renderCategories() {
  const categories = ['Todos', 'Combo', 'Marisco', 'Acompañante', 'Adición', 'Bebida'];
  $('#categories').innerHTML = categories.map(c => `<button class="${c === category ? 'active' : ''}" data-category="${c}" aria-pressed="${c === category}">${c === 'Combo' ? 'Combos' : c === 'Bebida' ? 'Bebidas' : c}</button>`).join('');
  document.querySelectorAll('[data-category]').forEach(el => el.onclick = () => { category = el.dataset.category; renderCategories(); renderProducts(); });
}
function renderProducts() {
  const normalize = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const items = catalog.items.filter(p => (category === 'Todos' || p.category === category) && normalize(p.name).includes(normalize(search)));
  $('#products').innerHTML = items.map(p => `<button class="product" data-product="${escape(p.id)}" ${draft.pending ? 'disabled' : ''}><span class="category">${escape(p.category)} · ${escape(p.portion)}</span><strong>${escape(p.name)}</strong><span class="bottom"><span class="price">${money(p.priceCop)}</span><span class="plus" aria-hidden="true">+</span></span></button>`).join('') || '<p class="empty">No encontramos ese producto.</p>';
  document.querySelectorAll('[data-product]').forEach(el => el.onclick = () => {
    if (draft.pending || busy) return; product = catalog.items.find(p => p.id === el.dataset.product);
    $('#product-form').reset(); $('#product-title').textContent = product.name; $('#product-price').textContent = `${money(product.priceCop)} / ${product.portion}`;
    $('#product-description').textContent = product.description; $('#heat-field').hidden = !product.heat; $('#product-dialog').showModal();
  });
}
function renderCart() {
  if(state.workflow)draft.waiter=state.actor.name;
  const items = enriched(draft.items), locked = Boolean(draft.pending);
  $('#cart').innerHTML = `<div class="cart-head"><h2>Mesa ${selected}</h2><span class="badge">${locked ? 'Por verificar' : 'Sin enviar'}</span></div><button class="cart-toggle back-menu" id="back-menu">← Volver al menú</button>${locked ? '<div class="retry-banner">Envío pendiente de respuesta. Verifica el mismo envío antes de cambiar el pedido.</div>' : ''}<label>Mesera <input id="waiter" ${state.workflow ? 'readonly' : ''} maxlength="50" placeholder="Tu nombre" value="${escape(draft.waiter)}" ${locked ? 'disabled' : ''}></label><div>${items.length ? items.map((i, index) => `<div class="cart-row"><div><h3>${escape(part(i))}</h3><p>${escape([i.heat ? `Picante ${i.heat}` : '', i.notes].filter(Boolean).join(' · '))}</p><p>${money(i.priceCop * i.quantity)}</p></div><button class="remove" data-remove="${index}" aria-label="Quitar ${escape(i.name)}" ${locked ? 'disabled' : ''}>×</button></div>`).join('') : '<div class="empty"><div class="empty-icon">+</div>La comanda empieza aquí.<br>Agrega los platos de la mesa.</div>'}</div><label>Nota de la mesa <textarea id="table-notes" rows="2" maxlength="500" placeholder="Detalles para cocina" ${locked ? 'disabled' : ''}>${escape(draft.notes)}</textarea></label><div class="total"><span>Total de referencia</span><span>${money(total(items))}</span></div><button id="review" class="primary full" ${!items.length || busy ? 'disabled' : ''}>${locked ? 'Verificar / reintentar envío' : 'Revisar y enviar'}</button><p id="save-status" class="save-status"></p><p class="fine">Precios del menú actual. Los cobros se registran por separado.</p>`;
  $('#waiter').oninput = e => { draft.waiter = e.target.value; saveDraft(); };
  $('#table-notes').oninput = e => { draft.notes = e.target.value; saveDraft(); };
  $('#back-menu').onclick = () => { mobileCart = false; setMobileView(); };
  document.querySelectorAll('[data-remove]').forEach(el => el.onclick = () => { draft.items.splice(Number(el.dataset.remove), 1); saveDraft(); renderCart(); renderTableSelection(); });
  $('#review').onclick = () => { if (draft.pending) return send(); if (!draft.waiter.trim()) { toast('Escribe el nombre de la mesera.'); $('#waiter').focus(); return; } $('#review-content').innerHTML = `<h2>Mesa ${selected}</h2><p class="muted">${escape(draft.waiter)} · ${activeVisit(selected) ? 'Nueva ronda' : 'Primera ronda'}</p>${lineList(items)}${draft.notes ? `<p class="note">${escape(draft.notes)}</p>` : ''}<div class="total"><span>Total de referencia</span><span>${money(total(items))}</span></div>`; $('#review-dialog').showModal(); };
  $('#mobile-bar').innerHTML = `<button class="primary" id="mobile-review">${mobileCart ? 'Volver al menú' : `Ver comanda · ${items.reduce((n, i) => n + i.quantity, 0)} artículos`}<span>${money(total(items))}</span></button>`;
  $('#mobile-review').onclick = () => { mobileCart = !mobileCart; setMobileView(); };
  saveDraft(); setMobileView();
}
function setMobileView() { document.body.classList.toggle('show-cart', mobileCart); const b = $('#mobile-review'); if (b) b.innerHTML = `${mobileCart ? 'Volver al menú' : `Ver comanda · ${draft.items.reduce((n, i) => n + i.quantity, 0)} artículos`}<span>${money(total(enriched(draft.items)))}</span>`; }
$('#product-form').onsubmit = event => { event.preventDefault(); if (draft.pending || busy) return; const f = new FormData(event.currentTarget); draft.items.push({ productId: product.id, quantity: Number(f.get('quantity')), heat: product.heat ? f.get('heat') : '', notes: f.get('notes').trim() }); saveDraft(); $('#product-dialog').close(); renderCart(); renderTableSelection(); toast(`${product.name} agregado. Aún no se envió.`); };
async function send() {
  if (busy) return; busy = true; $('#confirm-send').disabled = true;
  if (!draft.pending) draft.pending = { requestId: draft.requestId, table: selected, visitId: draft.visitId, catalogVersion: catalog.version, deviceId, waiter: draft.waiter.trim(), notes: draft.notes.trim(), items: structuredClone(draft.items) };
  saveDraft();
  if (!storageOK) { busy = false; draft.pending = null; $('#confirm-send').disabled = false; toast('Activa el almacenamiento del navegador antes de enviar; necesitamos conservar el envío para reintentar.'); return; }
  $('#review-dialog').close(); renderCart(); renderProducts();
  try {
    const ticket = await api('/api/tickets', draft.pending);
    const waiter = draft.waiter; draft = { table: selected, visitId: ticket.visit_id, waiter, notes: '', items: [], requestId: crypto.randomUUID(), pending: null }; saveDraft();
    toast(`Comanda #${ticket.id} recibida · Mesa ${ticket.table_no} · ronda ${ticket.round}`);
    await refresh(true); mobileCart = false;
  } catch (e) {
    // Definite validation rejection permits editing; ambiguous failures keep the exact request locked for safe retry.
    if (e.status >= 400 && e.status < 500) { draft.pending = null; draft.requestId = crypto.randomUUID(); saveDraft(); }
    toast(e.message);
    if (e.code === 'catalog_changed') { catalog = await api('/api/catalog'); renderCategories(); renderProducts(); toast('El menú cambió. Revisa los platos y precios; vuelve a confirmar antes de enviar.'); }
    else if (e.code === 'visit_changed') { await refresh(true); $('#review-content').innerHTML = '<h2>Revisa la mesa</h2><p>La visita cambió desde que empezaste este borrador. Conservamos tus platos. Revisa a quién corresponde el pedido; luego vuelve a enviarlo.</p><button id="accept-visit" class="primary full">Usar la visita actual de esta mesa</button>'; $('#confirm-send').hidden = true; $('#review-dialog').showModal(); $('#accept-visit').onclick = () => { draft.visitId = activeVisit(selected)?.id ?? null; saveDraft(); $('#review-dialog').close(); $('#confirm-send').hidden = false; }; }
  } finally { busy = false; $('#confirm-send').disabled = false; renderCart(); renderProducts(); renderTableSelection(); renderTableTickets(); }
}
$('#confirm-send').onclick = send;
function card(t, isKitchen = false) {
  const terminal = ['served', 'cancelled'].includes(t.state);
  let actions = '';
  if (isKitchen && can('Cook') && t.state === 'new') actions = `<button class="primary" data-state="cooking" data-id="${t.id}">Empezar a preparar</button>`;
  if (isKitchen && can('Cook') && t.state === 'cooking') actions = `<button class="primary" data-state="ready" data-id="${t.id}">Marcar lista</button>`;
  if (isKitchen && can('Cook') && t.state === 'cancel_requested' && (!t.onto_facts?.started || t.onto_facts?.approved)) actions = `<button class="danger" data-state="cancelled" data-id="${t.id}">Confirmar cancelación</button>`;
  if (!isKitchen && can('Waiter') && t.state === 'ready') actions = `<button class="primary" data-state="${t.source_order_id?'dispatched':'served'}" data-id="${t.id}">${t.source_order_id?'Despachar con domiciliario':'Ya entregada'}</button>`;
  if (!isKitchen && can('Waiter') && ['new','cooking','ready'].includes(t.state)) actions += `<button data-cancel="${t.id}">Cancelar</button>`;
  if(can('Waiter')&&t.state==='dispatched')actions+=`<button class="primary" data-state="served" data-id="${t.id}">Confirmar entrega</button>`;
  if(state.workflow&&can('Manager')&&t.state==='cancel_requested'&&!t.onto_facts?.approved)actions+=`<button class="danger" data-state="approved" data-id="${t.id}">Aprobar cancelación</button>`;
  if(t.state==='cancel_requested'&&t.onto_facts?.started&&!t.onto_facts.approved)actions+='<p class="fine">Cocina ya empezó. Falta aprobación de administración.</p>';
  return `<article class="ticket ${escape(t.state)}" data-ticket="${t.id}"><div class="ticket-top"><div><h3>${t.source_order_id?'Domicilio':`Mesa ${t.table_no}`}</h3><p class="ticket-number">#${String(t.id).padStart(3, '0')} · Ronda ${t.round}</p></div><span class="badge ${t.state}">${labels[t.state]}</span></div><div class="ticket-meta"><span>${escape(t.waiter)}</span><span>${time(t.created_at)} · <span data-age="${t.created_at}"></span></span></div>${lineList(t.items)}${t.notes ? `<p class="note">${escape(t.notes)}</p>` : ''}${t.cancel_reason ? `<p class="note cancel-note"><strong>Cancelación:</strong> ${escape(t.cancel_reason)}</p>` : ''}<div class="ticket-footer">${actions}<button class="quiet" data-print="${t.id}">Vista del ticket</button>${state.workflow?`<button class="quiet" data-reprint="${t.id}">Reimprimir copia</button>`:''}<button class="quiet" data-history="${t.id}">Historial</button></div></article>`;
}
function renderDeliveries(){const ts=state.tickets.filter(t=>t.source_order_id);$('#deliveries').innerHTML=ts.map(t=>card(t)).join('')||'<p class="empty">Los pedidos confirmados de WhatsApp aparecerán aquí.</p>';bindTickets();updateAges();}
function renderTableTickets() {
  const visit = activeVisit(selected), tickets = state.tickets.filter(t => t.visit_id === visit?.id);
  $('#table-tickets').innerHTML = tickets.map(t => card(t)).join('') || '<p class="muted">Todavía no hay comandas en esta visita.</p>';
  if (visit && tickets.every(t => ['served', 'cancelled'].includes(t.state))) {
    $('#table-tickets').insertAdjacentHTML('beforeend', '<button class="close-table" id="close-table">Terminar visita y liberar mesa</button><p class="fine">Solo termina el servicio. No registra un pago.</p>');
    $('#close-table').onclick = async () => { if (draft.items.length) return toast('Envía o quita los platos del borrador antes de liberar la mesa.'); try { await api(`/api/visits/${visit.id}/close`, { requestId: crypto.randomUUID() }); draft.visitId = null; saveDraft(); await refresh(true); toast('Mesa disponible para una nueva visita.'); } catch (e) { toast(e.message); } };
  }
  bindTickets(); updateAges();
}
function renderBoard() {
  const groups = [{ title: 'Por preparar', states: ['new', 'cancel_requested'] }, { title: 'En preparación', states: ['cooking'] }, { title: 'Listas para llevar', states: ['ready'] }];
  $('#board').innerHTML = groups.map(g => { const ts = state.tickets.filter(t => g.states.includes(t.state)).sort((a, b) => (b.state === 'cancel_requested') - (a.state === 'cancel_requested') || a.id - b.id); return `<section><div class="column-head"><h2>${g.title}</h2><span>${ts.length}</span></div>${ts.map(t => card(t, true)).join('') || '<div class="empty">Sin comandas aquí.</div>'}</section>`; }).join('');
  $('#history').innerHTML = state.tickets.filter(t => ['served', 'cancelled'].includes(t.state)).slice(0, 30).map(t => card(t, true)).join('') || '<p class="muted">Aún no hay comandas terminadas.</p>';
  bindTickets(); updateAges();
}
function bindTickets() {
  document.querySelectorAll('[data-reprint]').forEach(b=>b.onclick=async()=>{try{await api(`/api/tickets/${b.dataset.reprint}/reprint`,{requestId:crypto.randomUUID()});toast('Copia en cola. Revisa Impresora y WhatsApp para ver el resultado.');}catch(e){toast(e.message);}});
  document.querySelectorAll('[data-state]').forEach(b => b.onclick = async () => { const t = state.tickets.find(t => t.id === Number(b.dataset.id)); b.disabled = true; try { await api(`/api/tickets/${t.id}/state`, { requestId: crypto.randomUUID(), version: t.version, state: b.dataset.state }); await refresh(true); } catch (e) { toast(e.message); await refresh(true); } finally { b.disabled = false; } });
  document.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { cancelTicket = state.tickets.find(t => t.id === Number(b.dataset.cancel)); $('#cancel-form').reset(); $('#cancel-dialog').showModal(); });
  document.querySelectorAll('[data-print]').forEach(b => b.onclick = () => { const t = state.tickets.find(t => t.id === Number(b.dataset.print)); const content = `<div class="print-ticket"><p>KING CAJUN · MESA</p><h2>MESA ${t.table_no}</h2><p>COMANDA #${t.id} · RONDA ${t.round}<br>${time(t.created_at)} · ${escape(t.waiter)}<br>ESTADO: ${escape(labels[t.state])}</p>${lineList(t.items)}${t.notes ? `<p>NOTA: ${escape(t.notes)}</p>` : ''}${t.cancel_reason ? `<p>CANCELACIÓN: ${escape(t.cancel_reason)}</p>` : ''}<p>Copia generada: ${time(new Date())}</p></div>`; $('#print-preview').innerHTML = content; $('#print-sheet').innerHTML = content; $('#print-dialog').showModal(); });
  document.querySelectorAll('[data-history]').forEach(b => b.onclick = async () => { try { const rows = await api(`/api/tickets/${b.dataset.history}/history`); $('#history-content').innerHTML = rows.map(e => `<div class="history-event"><strong>${escape(e.action === 'created' ? 'Recibida' : labels[e.action] || e.action)}</strong><p>${new Date(e.at).toLocaleString('es-CO')}</p><p>${escape(e.detail)}</p></div>`).join(''); $('#history-dialog').showModal(); } catch (e) { toast(e.message); } });
}
$('#cancel-form').onsubmit = async e => { e.preventDefault(); const button = e.currentTarget.querySelector('[type=submit]'); button.disabled = true; const reason = new FormData(e.currentTarget).get('reason'); try { await api(`/api/tickets/${cancelTicket.id}/state`, { requestId: crypto.randomUUID(), version: cancelTicket.version, state: 'cancel_requested', reason }); $('#cancel-dialog').close(); toast('Cancelación enviada; falta confirmación de cocina.'); await refresh(true); } catch (e) { toast(e.message); await refresh(true); } finally { button.disabled = false; } };
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { document.getElementById(b.dataset.close).close(); if (b.dataset.close === 'review-dialog') $('#confirm-send').hidden = false; });
$('#review-dialog').addEventListener('cancel', () => { $('#confirm-send').hidden = false; });
$('#print-now').onclick = () => window.print();
function updateAges() { document.querySelectorAll('[data-age]').forEach(el => el.textContent = `${Math.max(0, Math.floor((Date.now() - new Date(el.dataset.age)) / 60000))} min`); }
function beep() { if (!sound || !audio) return; const o = audio.createOscillator(), g = audio.createGain(); o.connect(g); g.connect(audio.destination); o.frequency.value = 740; g.gain.value = 0.12; g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4); o.start(); o.stop(audio.currentTime + 0.4); }
function openReadyTable(table) {
  if (!Number.isInteger(table) || table < 1 || table > 12 || kitchen || !draft || busy) return;
  saveDraft(); selected = table; draft = readDraft(table); mobileCart = false;
  renderTableSelection(); renderCart(); renderProducts(); renderTableTickets();
  $('#table-tickets')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function updateReadyAlerts() {
  if (kitchen || deliveryView || !state) return;
  const ready = readyForDevice(state.tickets, deviceId);
  const banner = $('#ready-banner'), text = ready.map(t => `${t.id}:${t.table_no}`).join(',');
  if (banner.dataset.tickets !== text) {
    banner.dataset.tickets = text; banner.hidden = !ready.length;
    banner.innerHTML = ready.length ? `<strong>Listo para llevar</strong><div>${ready.map(t => `<button data-ready-table="${t.table_no}">Mesa ${t.table_no} · #${t.id} →</button>`).join('')}</div>` : '';
    banner.querySelectorAll('[data-ready-table]').forEach(b => b.onclick = () => openReadyTable(Number(b.dataset.readyTable)));
  }
  if (!document.hidden && readySoundEnabled && !pushActive) {
    const fresh = unseenReady(state.tickets, deviceId, readySeen);
    if (fresh.length) {
      signalReady({ context: foregroundAudio, navigator, visible: true });
      rememberReady(fresh, readySeen);
      try { sessionStorage.setItem('kc-ready-seen', JSON.stringify([...readySeen].slice(-1000))); } catch { /* The in-memory dedupe remains. */ }
      toast(fresh.map(t => `Mesa ${t.table_no} lista · #${t.id}`).join(' / '));
    }
  }
}
async function setupAlerts() {
  if (kitchen) return;
  $('#staff-alerts').hidden = false;
  $('#enable-ready-sound').onclick = async () => {
    if (readySoundEnabled) { readySoundEnabled = false; $('#enable-ready-sound').textContent = 'Activar avisos de pedido listo'; $('#alert-help').textContent = 'Aviso en pantalla activo. Sonido desactivado.'; return; }
    try {
      foregroundAudio = await activateForegroundAudio(window.AudioContext || window.webkitAudioContext); readySoundEnabled = true;
      $('#enable-ready-sound').textContent = 'Sonido activo · tocar para silenciar';
      $('#alert-help').textContent = typeof navigator.vibrate === 'function' ? 'App visible: sonido + vibración si el dispositivo lo permite. Prueba en el teléfono.' : 'App visible: sonido + aviso en pantalla. Este navegador no permite vibración directa.';
      signalReady({ context: foregroundAudio, navigator }); updateReadyAlerts();
    } catch (e) { toast(e.message); }
  };
  try {
    pushConfig = await api('/api/push/config');
    if (!pushConfig.enabled) { $('#push-help').textContent = 'iPhone bloqueado: falta configurar la versión HTTPS y activar notificaciones desde el icono en Inicio. Los avisos en pantalla siguen disponibles.'; return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { $('#push-help').textContent = 'Para notificaciones en iPhone: abre la versión HTTPS con Safari → Compartir → Agregar a Inicio. Luego abre el icono y activa notificaciones.'; return; }
    const registration = await navigator.serviceWorker.register('/mesas/service-worker.js', {scope:'/mesas/'}); await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing && Notification.permission === 'granted') { await api('/api/push/subscribe', { deviceId, subscription: existing.toJSON() }); pushActive = true; }
    $('#enable-push').disabled = false;
    const update = () => { $('#enable-push').textContent = pushActive ? 'Notificaciones activas · desactivar' : 'Activar notificaciones'; $('#push-help').textContent = pushActive ? 'Notificaciones registradas para las comandas enviadas desde este teléfono. iOS decide sonido y vibración; verifica los ajustes del iPhone.' : 'En iPhone: abre desde Inicio, permite notificaciones y comprueba sonidos/hápticos y Concentración. Aún no se ha probado en este teléfono.'; };
    update();
    $('#enable-push').onclick = async () => {
      const button = $('#enable-push'); button.disabled = true;
      try {
        if (pushActive) { const sub = await registration.pushManager.getSubscription(); if (sub) { await api('/api/push/unsubscribe', { deviceId, endpoint: sub.endpoint }); await sub.unsubscribe(); } pushActive = false; }
        else {
          const permission = await Notification.requestPermission(); if (permission !== 'granted') throw Error('Notificaciones no autorizadas. Los avisos en pantalla siguen disponibles.');
          const value = pushConfig.publicKey.replace(/-/g, '+').replace(/_/g, '/'); const keyBytes = Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
          const sub = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
          await api('/api/push/subscribe', { deviceId, subscription: sub.toJSON() }); pushActive = true;
        }
        update();
      } catch (e) { toast(e.message); } finally { button.disabled = false; }
    };
  } catch { $('#push-help').textContent = 'No se pudo verificar la configuración de notificaciones. El aviso en pantalla sigue disponible.'; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', event => { if (event.data?.type === 'open-ready-ticket') openReadyTable(event.data.table); });
async function refresh(force = false) {
  if (refreshing) return; refreshing = true;
  try {
    const next = await api('/api/state'); const hash = JSON.stringify([next.visits, next.tickets]);
    $('#connection').textContent = `● Actualizado ${time(next.serverTime)}`; $('#connection').classList.remove('bad');
    if (kitchen && !firstLoad && next.tickets.some(t => !knownTickets.has(t.id) && t.state === 'new')) beep();
    knownTickets = new Set(next.tickets.map(t => t.id)); firstLoad = false; state = next;
    if (force || hash !== lastHash) { lastHash = hash; if (!$('#board') && !$('#tables') && !$('#deliveries')) renderShell(); else if (kitchen) renderBoard(); else if(deliveryView)renderDeliveries(); else { renderTableSelection(); renderTableTickets(); } }
    updateReadyAlerts();
  } catch (e) { $('#connection').textContent = '● Sin conexión · datos sin actualizar'; $('#connection').classList.add('bad'); if (!state) $('#app').textContent = 'No se pudo cargar. Reintentando la conexión…'; }
  finally { refreshing = false; }
}
async function boot() { try { if (!kitchen) { const identity = await api('/api/device'); deviceId = identity.deviceId; } catalog = await api('/api/catalog'); await refresh(true); } catch { $('#app').textContent = 'No se pudo cargar el menú. Reintentando…'; $('#connection').textContent = '● Sin conexión'; $('#connection').classList.add('bad'); } }
if (embedded) new ResizeObserver(() => parent.postMessage({type:'kc-table-height',height:document.documentElement.scrollHeight},location.origin)).observe(document.body);
await boot(); if(!deliveryView)await setupAlerts(); setInterval(() => { if (catalog) refresh(); else boot(); }, 2000); setInterval(updateAges, 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });

$('#logout').onclick=async()=>{try{await api('/api/logout',{});location.href='/mesas/login';}catch(e){toast(e.message);}};
$('#jobs-button').onclick=async()=>{try{
 const jobs=await api('/api/jobs');const labels={simulated:'Simulado · no enviado a WhatsApp',pending:'En cola',sending:'Enviando',sent:'WhatsApp aceptó el envío',delivered:'Entregado por WhatsApp',spooled:'Enviado a la cola de la impresora',printed:'Impresión confirmada',failed:'Falló',unknown:'Sin confirmación: revisar',blocked:'Requiere configuración'};
 $('#history-content').innerHTML='<h2>Impresora y WhatsApp</h2><p class="fine">Enviar a la impresora no confirma que haya salido papel.</p>'+jobs.map(j=>`<div class="history-event"><strong>#${j.ticket_id} · ${j.kind==='print'?'Ticket':'WhatsApp'} · ${escape(labels[j.state]||j.state)}</strong><p>${escape(j.last_error||'')}</p>${can('Manager')&&['failed','unknown','blocked'].includes(j.state)?`<button data-retry-job="${j.id}">Verifiqué que no llegó: reintentar</button>`:''}</div>`).join('');$('#history-dialog').showModal();
 document.querySelectorAll('[data-retry-job]').forEach(b=>b.onclick=async()=>{await api(`/api/jobs/${b.dataset.retryJob}/retry`,{verifiedNotReceived:true});b.textContent='Reintento en cola';b.disabled=true;});
}catch(e){toast(e.message);}};
