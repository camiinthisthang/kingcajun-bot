// Coordinates identify a dispatch point, never delivery coverage or an order status.
export function validDispatchPoint(point) {
  return typeof point?.lat === 'number' && typeof point?.lng === 'number' &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    point.lat >= 5.8 && point.lat <= 6.65 && point.lng >= -75.9 && point.lng <= -75.2;
}
export function coordinatePair(text) {
  const match = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  return match ? {lat:Number(match[1]),lng:Number(match[2])} : null;
}
export function googleMapsUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (url.hostname === 'maps.app.goo.gl' && /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) return url;
  if (url.hostname === 'goo.gl' && /^\/maps\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) return url;
  if (['google.com','www.google.com','maps.google.com','google.com.co','www.google.com.co','maps.google.com.co'].includes(url.hostname) &&
      (/^\/maps(?:\/|$)/.test(url.pathname) || (url.hostname.startsWith('maps.') && url.pathname === '/'))) return url;
  return null;
}
export const isShortGoogleUrl = url => ['maps.app.goo.gl','goo.gl'].includes(url.hostname);
export function pointFromGoogleUrl(url) {
  // A camera center (@lat,lng) or a route can point somewhere other than the destination.
  if (/\/dir(?:\/|$)/.test(url.pathname) || url.searchParams.has('map_action')) return null;
  let decoded;
  try { decoded = decodeURIComponent(url.pathname + url.search); } catch { return null; }
  const places = [...decoded.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  if (places.length === 1) return {lat:Number(places[0][1]),lng:Number(places[0][2])};
  if (places.length > 1 || url.searchParams.has('query_place_id') || url.searchParams.has('cid')) return null;
  const query = coordinatePair(url.searchParams.get('query')) || coordinatePair(url.searchParams.get('q'));
  if (query) return query;
  const pathPoint = decoded.match(/^\/maps\/(?:place|search)\/([^/]+)/);
  return pathPoint ? coordinatePair(pathPoint[1].replace(/\+/g,' ')) : null;
}
export function storedDispatchLocation(order) {
  const point = order.delivery_coverage?.dispatchLocation;
  return point && point.sourceAddress === (order.delivery_address || '') && validDispatchPoint(point) ? point : null;
}
export function savedDispatchLocation(order) {
  return order.delivery_coverage?.locationConfirmation?.status==='needs_correction' ? null : storedDispatchLocation(order);
}
export const pointMapsLink = point => 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(point.lat+','+point.lng);
