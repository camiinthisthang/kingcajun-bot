export function canRefreshDashboard(page) {
  return !page.hidden && !page.querySelector('dialog[open]') &&
    !page.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
}

// Refresh the data, not the page: filters and unfinished form edits stay intact.
export function startDashboardRefresh(refresh, {
  page = document, browser = window, isBusy = () => false, intervalMs = 15000
} = {}) {
  let running = false;
  let stopped = false;
  async function check() {
    if (stopped || running || isBusy() || !canRefreshDashboard(page)) return;
    running = true;
    try { await refresh(); }
    catch { /* The dashboard loader displays connection errors. Retry next time. */ }
    finally { running = false; }
  }
  const timer = browser.setInterval(check, intervalMs);
  page.addEventListener('visibilitychange', check);
  browser.addEventListener('focus', check);
  browser.addEventListener('online', check);
  browser.addEventListener('pageshow', check);
  return () => {
    stopped = true;
    browser.clearInterval(timer);
    page.removeEventListener('visibilitychange', check);
    browser.removeEventListener('focus', check);
    browser.removeEventListener('online', check);
    browser.removeEventListener('pageshow', check);
  };
}
