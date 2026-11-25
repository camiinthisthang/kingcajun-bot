// Username-only users have a business-scoped user ID (BSUID), not a phone
// number. Keep it opaque and namespaced; never turn its digits into a phone.
export const isWhatsAppUserId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/i.test(value);
export function whatsappRecipient(phone?:unknown,userId?:unknown):string|undefined {
  if(typeof phone==='string'&&/^\+?[1-9]\d{6,14}$/.test(phone))return `+${phone.replace(/^\+/,'')}`;
  if(isWhatsAppUserId(userId))return `bsuid:${userId}`;
  return undefined;
}
export function whatsappAddress(recipient:string):{to:string}|{recipient:string} {
  if(recipient.startsWith('bsuid:')&&isWhatsAppUserId(recipient.slice(6)))return {recipient:recipient.slice(6)};
  if(/^\+?[1-9]\d{6,14}$/.test(recipient))return {to:recipient.replace(/^\+/,'')};
  throw new Error('Invalid WhatsApp recipient identifier');
}
