import {DateTime} from 'luxon';
import type {Config} from '../config.js';

export const capacityClosureReply = `¡Hola! 🦀👑 Este fin de semana estamos completos.

Anunciaremos las próximas fechas de entrega en nuestras redes:
📸 Instagram: https://www.instagram.com/kingcajun.co/
🎵 TikTok: https://www.tiktok.com/@kingcajun.co

¡Gracias por tu paciencia y apoyo! ❤️

📲 Toca «Lista de espera» para recibir avisos de nuevos cupos por WhatsApp. Puedes salir cuando quieras.

¿Ya tienes un pedido? Toca «Mi pedido». Para otras consultas, toca «Hablar con alguien».`;

export const capacityMenuButtons=[
 {id:'kc:opening_join',title:'Lista de espera'},
 {id:'kc:existing_order',title:'Mi pedido'},
 {id:'kc:human',title:'Hablar con alguien'}
];

export const grandOpeningReply = `¡Hola! 🦀 Soy el asistente virtual de King Cajun.

*¡Gran apertura: jueves 26 de noviembre!*

🕒 Jueves y viernes: *5:30–10 p. m.*
Sábados y domingos: *4:30–10 p. m.*

📍 Calle 3S #43a-40, El Poblado, Medellín, al lado del Hotel Estelar. *Hay parqueadero al lado.*

🛵 Domicilios: sábados y domingos, *6–10 p. m.* Pide por este WhatsApp.

Para pedir, toca «Hacer pedido». Para hablar con nuestro equipo, toca «Hablar con alguien».`;
export const grandOpeningButtons = [
 {id:'kc:view_menu',title:'Ver menú'},
 {id:'kc:human',title:'Hablar con alguien'}
];
export const openingButtons=(cfg:Config)=>cfg.SCHEDULED_ORDERING_ENABLED?[{id:'kc:place_order',title:'Hacer pedido'},...grandOpeningButtons]:grandOpeningButtons;
export const grandOpeningConsent = 'Quiero recibir por WhatsApp novedades de la apertura del restaurante King Cajun y su oferta de inauguración. Puedo salir de la lista en cualquier momento.';
export function grandOpening(cfg:Config) { return cfg.NEW_ORDERS_PAUSED && cfg.NEW_ORDERS_PAUSE_REASON === 'grand_opening'; }

export function atCapacity(cfg: Config) {
 return cfg.NEW_ORDERS_PAUSED && (cfg.NEW_ORDERS_PAUSE_REASON === 'capacity' || grandOpening(cfg));
}

// A check-back time is informational. Only the owner can reopen ordering.
export function orderingPauseReply(cfg:Config,now=new Date()) {
 if(grandOpening(cfg))return cfg.SCHEDULED_ORDERING_ENABLED?grandOpeningReply:grandOpeningReply.replace('Para pedir, toca «Hacer pedido». ','');
 if(atCapacity(cfg))return capacityClosureReply;
 const localNow=DateTime.fromJSDate(now).setZone(cfg.BUSINESS_TIMEZONE);
 const check=cfg.NEW_ORDERS_CHECK_BACK_AT?DateTime.fromISO(cfg.NEW_ORDERS_CHECK_BACK_AT).setZone(cfg.BUSINESS_TIMEZONE).setLocale('es'):null;
 let next='El equipo está revisando si se liberaron cupos por cancelaciones. Puedes volver a consultar más tarde.';
 if(check&&check.toMillis()>localNow.toMillis()){
  const tomorrow=check.toISODate()===localNow.plus({days:1}).toISODate();
  const today=check.toISODate()===localNow.toISODate();
  next=`Vuelve a escribirnos ${tomorrow?'mañana, ':today?'hoy, ':''}${check.toFormat("cccc d 'de' LLLL")}, a partir de las ${check.toFormat('h:mm a').toLowerCase()} (hora de Medellín), para consultar si se liberaron cupos por cancelaciones.`;
 }
 return `🦀 Por ahora hemos pausado la recepción de nuevos pedidos.\n\n${next}\n\nSi ya tienes un pedido registrado, puedes seguir consultándolo por este chat. ¡Gracias por tu paciencia! 👑`;
}
