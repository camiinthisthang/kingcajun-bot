self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Deliberately no fetch cache: never turn a failed order submission into an apparent success.
self.addEventListener('push', event => {
  let data; try { data = event.data.json(); } catch { return; }
  if (!Number.isInteger(data.ticketId) || !Number.isInteger(data.table)) return;
  event.waitUntil(self.registration.showNotification(data.title || 'Pedido listo', {
    body: data.body, tag: `kc-ready-${data.ticketId}`, icon: '/mesas/assets/icon-192.png',
    data: { url: `/mesas/app?table=${data.table}&ticket=${data.ticketId}` },
    // iOS decides haptics from system notification settings; this option is only honored on supported platforms.
    vibrate: [250, 120, 250, 120, 400],
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/mesas/app', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).pathname === '/mesas/app' && client.frameType === 'top-level');
    if (existing) { existing.postMessage({ type: 'open-ready-ticket', table: Number(url.searchParams.get('table')) }); return existing.focus(); }
    return self.clients.openWindow(url.href);
  })());
});
