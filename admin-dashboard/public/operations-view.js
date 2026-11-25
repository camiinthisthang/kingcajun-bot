// Display-only helpers. Never rewrite the saved address or order.
const bogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
export const deliveryDay = order => order.starts_at ? bogota.format(new Date(order.starts_at)) : '';
export function fulfillment(order) {
  const c = order.delivery_coverage || {};
  return c.method || (['pickup', 'own_courier'].includes(c.preference) ? c.preference : order.fulfillment_type) || 'delivery';
}
export function displayAddress(order) {
  if (['pickup', 'own_courier'].includes(fulfillment(order))) return 'pickup';
  return String(order.delivery_address || '').split(/\n|\s*;\s*/).map(line => line.trim())
    .filter(line => line && !/^(?:el equipo |subiendo |punto de referencia|cerca (?:a|al|de) |lo made los )/i.test(line) && !/^(?:\+?57\s*)?3(?:[\s-]*\d){9}$/.test(line))
    .join(', ').replace(/(?:[,.;]\s*|\s+)(?:el equipo (?:enviar[áa]|te enviar[áa])|entrega (?:acordada|programada)|(?:viernes|s[áa]bado|domingo)\s+\d{1,2}\b|(?:hora|horario|franja)\s*:).*$/i, '')
    .replace(/\s+/g, ' ').replace(/[,;\s.]+$/, '') || 'Sin dirección';
}
export function filteredOrders(orders, {day = '', search = '', method = '', sort = 'delivery', scope = 'all'} = {}) {
  const q = normalize(search);
  const rows = orders.filter(o => (scope==='all'||scope==='confirmed'&&readyDelivery(o)||scope==='pending'&&['awaiting_payment','delivery_review','payment_review'].includes(o.status)) && (!day || deliveryDay(o) === day) && (!method || (method === 'pickup' ? ['pickup','own_courier'].includes(fulfillment(o)) : fulfillment(o) === 'delivery')) && (!q || normalize([o.public_id, o.display_name, displayAddress(o)].join(' ')).includes(q)));
  const compareText = (a,b) => String(a || '').localeCompare(String(b || ''), 'es', {numeric:true,sensitivity:'base'});
  return rows.sort((a,b) => {
    if(sort === 'customer') return compareText(a.display_name,b.display_name) || compareText(a.public_id,b.public_id);
    if(sort === 'address') return compareText(displayAddress(a),displayAddress(b)) || compareText(a.public_id,b.public_id);
    if(sort === 'total-desc') return b.total_cop-a.total_cop || compareText(a.public_id,b.public_id);
    if(sort === 'total-asc') return a.total_cop-b.total_cop || compareText(a.public_id,b.public_id);
    if(sort === 'newest') return new Date(b.created_at)-new Date(a.created_at) || compareText(a.public_id,b.public_id);
    return new Date(a.starts_at)-new Date(b.starts_at) || compareText(displayAddress(a),displayAddress(b)) || compareText(a.public_id,b.public_id);
  });
}
export const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export const mapEligible = o => fulfillment(o) === 'delivery' && !['cancelled','expired'].includes(o.status);
export const readyDelivery = o => ['confirmed','fulfilled'].includes(o.status) && !o.delivery_coverage?.needsReview;
// Send only street and municipality to the locator; never customer/contact/order data.
export function geocodeQuery(order) {
  if(!mapEligible(order)||order.delivery_coverage?.locationConfirmation?.status==='needs_correction') return null;
  const address = displayAddress(order);
  const source = normalize(address+' '+(order.delivery_coverage?.label||''));
  const city = /\benvigado\b/.test(source) ? 'Envigado' : /\bsabaneta\b/.test(source) ? 'Sabaneta' : /\bitagui\b/.test(source) ? 'Itagüí' : /\bbello\b/.test(source) ? 'Bello' : /\bla estrella\b/.test(source) ? 'La Estrella' : 'Medellín';
  const street = address.replace(/(#\s*\d+\s*[a-z]+)(?=\d)/ig,'$1-').match(/\b(?:carrera|cra|cr|calle|cll|cl|circular|circ|transversal|transv|tv|diagonal|diag|dg|avenida|av)\.?\s*\d+\s*[a-z]{0,2}(?:\s*(?:sur|norte|este|oeste))?\s*(?:#|nro\.?|n[uú]mero|n[°ºo.]?|\s)\s*\d+\s*[a-z]{0,2}(?:\s*(?:sur|norte|este|oeste))?\s*[-– ]\s*\d+\b/i)?.[0];
  if(!street) return null;
  return {street:street.trim().replace(/^cra?\.?\s*/i,'Carrera ').replace(/^cll?\.?\s*/i,'Calle '),city};
}
function streetKey(value) {
  return normalize(value).split(',')[0].replace(/^(?:cra|cr)\.?\s*(?=\d)/,'carrera ').replace(/^(?:cll|cl)\.?\s*(?=\d)/,'calle ').replace(/\b(?:nro|numero)\.?\s*/g,'').replace(/[^a-z0-9]/g,'');
}
export function acceptedCandidate(candidates, query) {
  return candidates.find(c => (!query.street || streetKey(c.attributes?.Match_addr || c.address || '') === streetKey(query.street)) && Number(c.score) >= 90 && ['PointAddress','StreetAddress','Subaddress'].includes(c.attributes?.Addr_type) && normalize(c.attributes?.City||'') === normalize(query.city) && Number.isFinite(c.location?.x) && Number.isFinite(c.location?.y) && c.location.y > 5.9 && c.location.y < 6.55 && c.location.x > -75.8 && c.location.x < -75.3) || null;
}
