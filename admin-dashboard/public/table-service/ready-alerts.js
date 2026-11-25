// A device owns tickets it submitted. Viewing another table must not subscribe it to that table's tickets.
export function readyForDevice(tickets, deviceId) {
  return tickets.filter(t => t.device_id === deviceId && t.state === 'ready');
}
export function unseenReady(tickets, deviceId, seen) {
  return readyForDevice(tickets, deviceId).filter(t => !seen.has(t.id));
}
export function rememberReady(tickets, seen) { for (const t of tickets) seen.add(t.id); }

export async function activateForegroundAudio(AudioContextClass) {
  if (!AudioContextClass) throw Error('Este navegador no permite activar el sonido.');
  const context = new AudioContextClass(); await context.resume();
  if (context.state !== 'running') throw Error('No se pudo activar el sonido. Vuelve a tocar el botón.');
  return context;
}
export function signalReady({ context, navigator, visible = true }) {
  if (!visible) return { audio: false, vibrationRequested: false };
  let audio = false, vibrationRequested = false;
  if (context?.state === 'running') {
    try {
      for (const offset of [0, 0.22, 0.44]) {
        const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime + offset;
        oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.13, start); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
        oscillator.start(start); oscillator.stop(start + 0.18);
      }
      audio = true;
    } catch { /* The visible ready banner remains usable. */ }
  }
  try { if (typeof navigator?.vibrate === 'function') vibrationRequested = navigator.vibrate([250, 120, 250, 120, 400]) === true; } catch { /* Unsupported devices keep the visual/sound path. */ }
  return { audio, vibrationRequested };
}
