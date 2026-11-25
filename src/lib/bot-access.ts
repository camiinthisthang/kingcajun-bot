import type { Config } from '../config.js';

export const allowedWhatsAppNumbers = (cfg: Config) =>
  cfg.WHATSAPP_ALLOWED_NUMBERS.split(',').map(phone => phone.trim()).filter(Boolean);

export const publicBotOpen = (cfg: Config) => cfg.BOT_AUDIENCE === 'all' || (!cfg.PHONE_PREVIEW && Boolean(cfg.BOT_PUBLIC_OPENS_AT) && Date.now() >= Date.parse(cfg.BOT_PUBLIC_OPENS_AT!));

export function canUseBot(cfg: Config, phone: string) {
  if (publicBotOpen(cfg)) return true;
  // Exact international numbers only; no suffix matching or inferred country.
  const canonical = /^\+?[1-9]\d{7,14}$/.test(phone) ? `+${phone.replace(/^\+/, '')}` : '';
  return Boolean(canonical) && allowedWhatsAppNumbers(cfg).includes(canonical);
}

export function requireBotAccess(cfg: Config, phone: string) {
  if (!canUseBot(cfg, phone)) throw new Error('WhatsApp recipient is not on the bot allowlist');
}
