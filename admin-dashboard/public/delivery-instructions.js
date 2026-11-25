// Shared, read-only presentation for the order map and planned routes.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Keep the original wording: a preference must never become a guaranteed time.
export function savedDeliveryRequests(order) {
  if (['cancelled','expired'].includes(order.status)) return [];
  const lines = typeof order.notes === 'string' ? order.notes.split(/\n+|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/).map(v=>v.trim()).filter(Boolean) : [];
  const relevant = lines.filter(line => /prioridad|ruta|agrupar|ambas franjas|verificar pin|horari|mediod[ií]a|recogida|recoger|mensajero|llamar|avisar|escribir|textear|porter[ií]a|timbre|entrada|letrero|recib(?:ir|e|en)|lleg(?:ar|ue|ada)|entregar|entrega (?:especial|antes|despu[eé]s|a las|entre|alrededor)|(?:antes|despu[eé]s|a partir) de (?:las|la) \d|\b\d{1,2}(?::\d{2})?\s*(?:a\.?\s*m|p\.?\s*m)\b/i.test(line));
  return [...new Set([order.delivery_coverage?.deliveryPromise?.note, ...relevant].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()))];
}
export function deliveryInstructions(order, routeNote = '') {
  return {
    startsAt: order.starts_at || null,
    endsAt: order.ends_at || null,
    requests: [...new Set([...savedDeliveryRequests(order), routeNote].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))],
    orderNotes: typeof order.notes === 'string' ? order.notes.trim() : ''
  };
}
export function deliveryInstructionsHTML(info) {
  if (!info) return '';
  const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('es-CO', {timeZone:'America/Bogota',hour:'numeric',minute:'2-digit'}).format(new Date(value)) : '';
  const start = time(info.startsAt), end = time(info.endsAt);
  const requests = info.requests || [];
  const notes = info.orderNotes && !requests.includes(info.orderNotes) ? info.orderNotes : '';
  return `<div class="delivery-instructions">${start ? `<p class="delivery-window"><strong>Franja de entrega:</strong> ${esc(start)}${end ? ' – '+esc(end) : ''}</p>` : ''}${requests.length ? `<div class="delivery-attention"><strong>Horario / solicitud acordada</strong>${requests.map(note=>`<p>${esc(note)}</p>`).join('')}</div>` : ''}${notes ? `<details class="delivery-order-notes"${requests.length ? '' : ' open'}><summary>Notas del pedido</summary><p>${esc(notes)}</p></details>` : ''}</div>`;
}
