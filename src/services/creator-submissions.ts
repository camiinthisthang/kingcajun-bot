import {normalizeText} from '../lib/format.js';
import type {ConversationContext} from '../types.js';

export const creatorAcknowledgement='¡Gracias por compartir tu contenido! 🦀 Nuestro equipo revisará tu propuesta.';
export const creatorLinkRequest='¡Gracias por tu interés en crear contenido con King Cajun! 🦀 Compártenos el enlace de tu Instagram o de un reel para que el equipo revise tu propuesta.';

// Recognize submissions without fetching untrusted links or asking the sales AI.
export function creatorSubmission(text:string,context:ConversationContext) {
 const clean=normalizeText(text);
 const explicit=/\b(?:ugc|creador(?:a|es|as)? de contenido|creacion de contenido|content creator|influencer|colaboracion|colaborar|portafolio|portfolio)\b/.test(clean)
  || /\b(?:mi|mis|te envio|te comparto|les envio|les comparto)\b.*\b(?:instagram|perfil|reels?|contenido)\b/.test(clean);
 const urls=[...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+|(?:instagram\.com|instagr\.am)\/[^\s<>]+/gi)].map(m=>m[0].replace(/[),.;!?]+$/,''));
 const links=[...new Set(urls.flatMap(raw=>{try{const u=new URL(/^https?:\/\//i.test(raw)?raw:'https://'+raw);return ['https:','http:'].includes(u.protocol)?[u.href]:[];}catch{return [];}}))];
 const social=links.some(link=>{
  const u=new URL(link),host=u.hostname.toLowerCase().replace(/^www\./,'');
  return ['instagram.com','instagr.am'].includes(host)&&!/^\/(?:kingcajun\.co|accounts|explore)(?:\/|$)/i.test(u.pathname)&&u.pathname!=='/';
 });
 const ordering=/\b(?:pedir|pedido|ordenar|comprar|precio|cuesta|cuanto vale|combo|domicilio|pago|pague|comprobante|direccion|quiero comer)\b/.test(clean);
 const active=!!context.creatorSubmission;
 if(!active&&!explicit&&(!social||context.orderingOptIn||ordering))return null;
 if(!active&&!explicit&&!social)return null;
 return {links,hasSubmission:links.length>0};
}
