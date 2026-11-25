import type { InboundMessage } from '../types.js';
import { normalizeText } from '../lib/format.js';
import { defaultFlow } from '../../admin-dashboard/src/flow/store.mjs';

export const mainMenuButtons = [
  { id: 'kc:place_order', title: 'Hacer pedido' },
  { id: 'kc:view_menu', title: 'Ver menú' },
  { id: 'kc:human', title: 'Hablar con alguien' }
];
export const mainMenuBody = defaultFlow().messages.main_menu;
export function configuredMainMenuButtons(messages: Record<string,string>) {
  return mainMenuButtons.map((button,index)=>({...button,title:messages[['main_menu_order','main_menu_catalog','main_menu_human'][index]!]!}));
}
export function mainMenuAction(message: InboundMessage, messages = defaultFlow().messages) {
  // IDs, not editable button labels, decide how interactive replies are routed.
  const actions: Record<string, 'order' | 'catalog' | 'human'> = {
    'kc:place_order': 'order', 'kc:view_menu': 'catalog', 'kc:human': 'human'
  };
  if (message.actionId) return actions[message.actionId] ?? 'unknown';
  const text = normalizeText(message.text);
  const labelAction = configuredMainMenuButtons(messages).find(button=>normalizeText(button.title)===text);
  if(labelAction)return actions[labelAction.id];
  // Food-menu requests go straight to the approved menu artwork, including
  // plain "menú" and price questions in replies to our announcements.
  const foodQuestion=text.replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if(foodQuestion!=='menu principal'&&(
    /\b(?:menu|carta)\b/.test(foodQuestion)||
    /\bprecios?\b/.test(foodQuestion)&&!/\b(?:domicilios?|envios?|entregas?|parqueadero)\b/.test(foodQuestion)
  ))return 'catalog';
  if (['hacer pedido', 'place order', 'pedido'].includes(text)) return 'order';
  if (['ver menu', 'carta'].includes(text)) return 'catalog';
  if (/\b(?:menu|carta)\b/.test(text)&&(
    /^(?:el )?(?:menu|carta)(?: (?:por favor|porfa|porfis|gracias))$/.test(text)||
    /^(?:hola |buenas )?(?:(?:me )?(?:puedes|podrias|podrian) )?(?:(?:me|nos) )?(?:mandar|mandas?|mandan|enviar?|envias?|envian|pasar|pasas?|compartir|compartes?|comparten|regalar|regalas?|muestras?|muestrame|mostrar|mandame|enviame|pasame|comparteme|regalame) (?:por favor )?(?:(?:el|la|tu|su|un|una) )?(?:menu|carta)(?: (?:nuevo|nueva|por favor|porfa|gracias))*$/.test(text)||
    /^(?:(?:quiero|quisiera|puedo) ver|tienes|tienen|me das) (?:(?:el|la|tu|su|un|una) )?(?:menu|carta)(?: (?:por favor|porfa))*$/.test(text)
  )) return 'catalog';
  if (['hablar con alguien', 'hablar con una persona', 'asesor', 'humano'].includes(text)) return 'human';
  if (['menu', 'menu principal', 'salir'].includes(text)) return 'menu';
  return undefined;
}
