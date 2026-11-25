import {normalizeText} from '../lib/format.js';

// The only approved customer response artwork. Do not use environment URLs or
// historical media from a conversation to choose a response image.
export const responseImages = {
  location:'/assets/responses-20261123/location.png',
  combos:'/assets/responses-20261122/menu-combos.png',
  build:'/assets/responses-20261122/menu-build.png',
  delivery:'/assets/responses-20261122/delivery.png',
  hours:'/assets/responses-20261122/hours.png'
} as const;
export const restaurantAddress='Calle 3S #43A-40, El Poblado, Medellín, al lado del Hotel Estelar y diagonal a Milla de Oro.';
export const restaurantHours='Jueves y viernes: 5:30–10 p. m. Sábados y domingos: 4:30–10 p. m. Lunes a miércoles: cerrado.';
export const openingNotice=(now=new Date())=>now.toISOString()<'2026-11-26T22:30:00.000Z'?'Apertura al público: jueves 26 de noviembre de 2026.':'';
const clean=(value:string)=>normalizeText(value).replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

export function asksRestaurantLocation(message:string) {
  const text=clean(message);
  // A customer's delivery address/correction is an order detail, not our address.
  if(/\b(?:mi direccion|mi ubicacion|mi local|mi casa|cambiar (?:la )?direccion|direccion incorrecta|ubicacion incorrecta|vivo en|estoy en)\b/.test(text)&&! /\b(?:su direccion|su ubicacion|su local|del restaurante|de king cajun|ustedes|donde (?:estan|quedan))\b/.test(text))return false;
  if(/\b(?:calle|carrera|cra|cl|transversal|diagonal|avenida)\s*\d/.test(text)&&! /\b(?:ustedes|su local|su direccion|quedan|estan ubicados|restaurante)\b/.test(text))return false;
  return /\b(?:direcci[o]?n|direccion|ubicaci[o]?n|ubicacion|local fisico|restaurante fisico|donde (?:estan|quedan|queda|se encuentran|estan ubicados|se ubican|puedo recoger)|como (?:llego|llegar)|tienen (?:un )?(?:local|restaurante|sede)|hay (?:un )?local|(?:direccion|ubicacion|mapa) del (?:local|restaurante)|ir (?:al local|a comer)|comer (?:alla|alli|en el local)|recoger (?:donde|en donde)|where (?:are you|is the restaurant)|address|location)\b/.test(text)
    || /^(?:el |su )?local(?: por favor| porfa)?$/.test(text)
    || /\b(?:su local|el local|al local)\b/.test(text)&&/\b(?:donde|ver|ubic|direccion|llegar|ir|tienen)\b/.test(text);
}

export function asksRestaurantHours(message:string) {
  const text=clean(message);
  if(/\b(?:mi pedido|llega mi|entregan mi|hora de entrega)\b/.test(text))return false;
  return /\b(?:horarios?|a que hora (?:abren|cierran)|cuando abren|cuando es la apertura|fecha de apertura|estan abiertos|abren hoy|opening hours|when do you open)\b/.test(text);
}

export function asksAmbiguousMap(message:string) {
  const text=clean(message);
  return /\bmapa\b/.test(text)&&!asksRestaurantLocation(message)&&!/\b(?:domicilios?|entregas?|cobertura|delivery|llegan|cubren|mi direccion|mi ubicacion|mi pedido|incorrecto|esta mal)\b/.test(text);
}

export const restaurantInstructions=`LOCAL FÍSICO: ${restaurantAddress} Apertura pública el 26 de noviembre de 2026. ${restaurantHours} Se atiende sin reservas, por orden de llegada. Recogida los días de apertura; domicilios solo sábados y domingos. Dirección, ubicación, local, cómo llegar y dónde recoger preguntan por el restaurante: coverageQuestion=null, responde con esta dirección, nunca con el mapa de domicilios ni pidas el barrio del cliente. Una consulta de cobertura es distinta. Si solo dice mapa sin contexto, pregunta si busca el local o la zona de domicilios. No afirmes que ya abrimos antes de la fecha. No afirmes que no hay consumo en local ni ocultes la dirección hasta el día del pedido.`;
