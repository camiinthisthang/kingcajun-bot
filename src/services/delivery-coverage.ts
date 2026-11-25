import {asksRestaurantLocation,asksAmbiguousMap} from './restaurant-information.js';
import {normalizeText} from '../lib/format.js';
import {pickupLocationNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';

// Transcribed from Camila's approved delivery map, not inferred from a city's name.
// This is a locality check, NOT geocoding or a street/pin-level geofence.
export const deliveryCoveragePolicy = {
  version:'2026-11-22-map',
  coveredMedellinAreas:['Laureles-Estadio','La Candelaria','Belén','Guayabal','El Poblado'],
  coveredMunicipalities:['Envigado'],
  // Envigado council agreements 019/2002 and 064/2005 locate Gualandayes in El Dorado.
  coveredEnvigadoAreas:['El Dorado','Gualandayes'],
  outsideAreas:['La América','Villa Hermosa','Buenos Aires','Robledo','Aranjuez','Manrique','San Javier','San Cristóbal','Santa Elena'],
  outsideMunicipalities:['Itagüí','Sabaneta','Bello','La Estrella','Caldas','Copacabana','Girardota','Barbosa'],
  pickup:`${pickupLocationNotice} No tiene costo de domicilio ni requiere revisión de cobertura, incluyendo mensajero propio. Se confirma al completar el pedido y verificar el pago que corresponda según la política de ese pedido. Una reserva con pago completo conserva esa condición al cambiar a recogida. Nunca inventar ni prometer una hora anterior a las franjas disponibles.`,
  limitation:'Solo valida zonas nombradas por el cliente. Medellín sin barrio/comuna, direcciones sin zona, límites y lugares no reconocidos requieren revisión; nunca adivinar coordenadas.'
} as const;
export type DeliveryLocation = {municipality:string|null;area:string|null};
export type DeliveryPreference = 'review'|'pickup'|'own_courier';
export type CoverageAssessment = {status:'inside'|'outside'|'unknown';label:string;policyVersion:string};
export type DeliveryCoverage = CoverageAssessment & {checkoutReview?:{status:'pending'|'resolved';notes:string[]};preference:DeliveryPreference|null;needsReview:boolean;method?:'delivery'|'pickup'|'own_courier';contactPhones?:string[];singleContactAccepted?:boolean;destinationZone?:string;capacityZone?:string};
const norm=(s:string)=>normalizeText(s).replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const aliases:Record<string,string>={'laureles':'Laureles-Estadio','estadio':'Laureles-Estadio','laureles estadio':'Laureles-Estadio','america':'La América','la america':'La América','candelaria':'La Candelaria','poblado':'El Poblado','el poblado':'El Poblado','villa hermosa':'Villa Hermosa','villahermosa':'Villa Hermosa'};
// The city lists this barrio within the already approved Comuna 14 (El Poblado):
// https://www.medellin.gov.co/es/conoce-algunos-datos-generales-de-la-ciudad/
aliases['altos del poblado']='El Poblado';
const allNames=[...deliveryCoveragePolicy.coveredMedellinAreas,...deliveryCoveragePolicy.coveredMunicipalities,...deliveryCoveragePolicy.outsideAreas,...deliveryCoveragePolicy.outsideMunicipalities,'Medellín'];
for(const name of allNames)aliases[norm(name)]=name;
// A single typo is accepted only when it has exactly one match. No substring
// matches (e.g. "Edificio Envigado" is not the municipality of Envigado).
function oneTypo(a:string,b:string){
  if(Math.abs(a.length-b.length)>1)return false;
  let i=0,j=0,changes=0;
  while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++changes>1)return false;if(a.length>=b.length)i++;if(b.length>=a.length)j++;}
  return changes+(i<a.length||j<b.length?1:0)<=1;
}
function canonical(raw:string|null){
  if(!raw)return null;const key=norm(raw);if(aliases[key])return aliases[key];
  if(key.length<6)return null;
  const matches=[...new Set(Object.entries(aliases).filter(([alias])=>oneTypo(key,alias)).map(([,name])=>name))];
  return matches.length===1?matches[0]!:null;
}
export function assessDeliveryCoverage(location:DeliveryLocation):CoverageAssessment {
  const city=canonical(location.municipality),area=canonical(location.area);
  const envigadoArea=deliveryCoveragePolicy.coveredEnvigadoAreas.find(a=>norm(a)===norm(location.area??'').replace(/^(barrio|urbanizacion) /,''));
  const result=(status:CoverageAssessment['status'],label:string)=>({status,label,policyVersion:deliveryCoveragePolicy.version});
  const outside=[...deliveryCoveragePolicy.outsideAreas,...deliveryCoveragePolicy.outsideMunicipalities] as string[];
  if(city==='Envigado'&&envigadoArea)return result('inside',`${envigadoArea}, Envigado`);
  // Conflicting locations are ambiguous, never an automatic green light.
  if(city&&city!=='Medellín'&&area&&area!==city)return result('unknown','Municipio y zona por aclarar');
  if(outside.includes(city??'')||outside.includes(area??''))return result('outside',city&&outside.includes(city)?city:area!);
  if(location.municipality&&!city)return result('unknown','Municipio por verificar');
  if(city==='Envigado'&&(!location.area||area==='Envigado'))return result('inside','Envigado');
  // An unrecognized sub-area in Envigado may be rural/on the boundary.
  if(city==='Envigado'&&location.area&&!area)return result('unknown','Sector de Envigado por verificar');
  if(area==='Envigado'&&city!=='Medellín')return result('inside','Envigado');
  if((deliveryCoveragePolicy.coveredMedellinAreas as readonly string[]).includes(area??''))return result('inside',area!);
  return result('unknown','Barrio y municipio por verificar');
}
export function literalLocation(location:DeliveryLocation,message:string){
  return [location.area,location.municipality].every(value=>value===null||!!value.trim()&&norm(message).includes(norm(value)));
}
// Legacy numeric flow: only explicit comma-separated place names are trusted.
export function locationFromAddress(address:string):DeliveryLocation {
  const parts=address.split(/[,;\n]/).map(s=>s.trim());
  const cities=['Medellín',...deliveryCoveragePolicy.coveredMunicipalities,...deliveryCoveragePolicy.outsideMunicipalities] as string[];
  let municipality=parts.find(p=>cities.includes(canonical(p)??''))??null;
  let area=parts.find(p=>!!canonical(p)&&!cities.includes(canonical(p)!))??null;
  const plain=norm(address);
  if(/\burbanizacion gualandayes envigado\b/.test(plain)){municipality='Envigado';area='Gualandayes';}
  if(municipality&&canonical(municipality)==='Envigado'){
    const known=deliveryCoveragePolicy.coveredEnvigadoAreas.find(a=>new RegExp('\\b'+norm(a)+'\\b').test(plain));
    if(known)area=known;
  }
  return {municipality,area};
}
export function coverageSnapshot(location:DeliveryLocation,preference:DeliveryPreference|null=null):DeliveryCoverage {
  const assessment=assessDeliveryCoverage(location);
  if(preference==='pickup'||preference==='own_courier')return {...assessment,preference,method:preference,needsReview:false};
  return {...assessment,preference,needsReview:assessment.status!=='inside',...(specialDeliveryZone(location)?{destinationZone:'itagui'}:{})};
}
// Only an explicit destination qualifies. A building name or a coverage question
// does not move a customer's order into this capacity pool.
export function specialDeliveryZone(location:DeliveryLocation):'itagui'|null {
  return assessDeliveryCoverage(location).label==='Itagüí'?'itagui':null;
}
export function coverageWarning(assessment:CoverageAssessment, _barrioProvided=false){
  return assessment.status==='outside'
    ? `${assessment.label} está fuera de nuestra zona de domicilios. Puedes recoger en El Poblado, enviar tu propio mensajero o continuar para que el equipo revise una alternativa, sin promesa de entrega. Tu pedido sigue guardado.`
    : '¿Cuál es el nombre del barrio?';
}

export const coverageQuestionInstructions = `Cuando pregunten si tenemos domicilios (por ejemplo «¿Tienen domicilio?»), por la zona de domicilios, cobertura, si llegamos a un lugar o pidan explícitamente el mapa de domicilios, devuelve coverageQuestion con municipality y area (null si no se especifican). Incluye seguimientos como '¿y allá?' usando el historial. Es independiente de deliveryLocation: una pregunta NO cambia la dirección del pedido. Usa solo nombres literales del cliente, nunca deduzcas un barrio. El sistema comprueba la cobertura, adjunta el mapa y muestra las fechas disponibles en vivo, aclarando que son entregas programadas. Para Bello y cualquier zona excluida la respuesta es NO, nunca 'sí, pero'. No escribas otra respuesta de cobertura en reply. Si hay dudas, pregunta «¿Cuál es el nombre del barrio?» como máximo UNA vez. Nunca pidas el municipio; conserva ese dato únicamente si el cliente lo ofrece. Si el historial o savedDetails.barrioAlreadyAsked indican que ya se preguntó, o el cliente ya dio un barrio que no reconoces, NO vuelvas a pedirlo. En un pedido activo usa intent=continue, conserva todos los datos y deja que el sistema avance con revisión de cobertura por el equipo, sin prometer entrega. Una respuesta como «no sé», una pregunta por la cuenta bancaria o un barrio desconocido después de esa única pregunta no deben bloquear el pedido ni iniciar otra pregunta de barrio. En un pedido activo, la respuesta con el barrio aclara deliveryLocation y usa intent=continue, conservando carrito, picante, fecha, horario y dirección. No la trates como una nueva consulta de cobertura ni vuelvas a enviar el mapa si no hizo una pregunta. Si aún no se reconoce, no prometas cobertura ni exijas que el cliente solicite revisión: el sistema continúa y avisa que el equipo revisará. Dirección, ubicación, local, dónde quedan, cómo llegar o dónde recoger son consultas del restaurante, no de cobertura: coverageQuestion=null. No envíes mapa de cobertura para ellas. Para preguntas ajenas a cobertura, coverageQuestion=null.`;

export const asksGenericDelivery=(message:string)=>/\b(?:(?:tienes?|tienen|haces?|hacen|hay|ofreces?|ofrecen|manejas?|manejan|cuentas? con|cuentan con) (?:ya )?(?:servicio de )?(?:domicilios?|delivery)|(?:do you|you) deliver)\b/.test(norm(message));

// Recognize explicit coverage wording even if the model forgets its topic field.
// The model may identify an unfamiliar question, but it never decides coverage.
export function coverageQuestionReply(message:string, question?:DeliveryLocation|null, history:Array<{role:string;text:string}>=[]):string|null {
  if(asksRestaurantLocation(message)||asksAmbiguousMap(message))return null;
  const text=norm(message);
  const generic=asksGenericDelivery(message);
  const mentioned=[...new Set(Object.entries(aliases).filter(([alias])=>` ${text} `.includes(` ${alias} `)).map(([,name])=>name))];
  const explicit=/\b(cobertura|zona de (domicilio|entrega)|zonas de (domicilio|entrega)|mapa de domicilios|mapa de cobertura|hasta donde|a donde (llegan|entregan)|por donde (llegan|entregan)|llegan (a|hasta)|entregan a|domicilios? (para|a|en|hasta)|delivery (to|area))\b/.test(text);
  const followup=mentioned.length>0&&(/^(y )?(en|a|para) .+/.test(text)&&/[¿?]/.test(message)||/^y (en |a |para )?/.test(text)||/\bentregan en\b/.test(text));
  // A model topic is not evidence of a question: address and food statements must advance checkout.
  const questionWording=/[¿?]/.test(message)||/\b(llegan|cubren|atienden|hacen envios|quisiera saber|quiero saber)\b/.test(text);
  if(!generic&&!explicit&&!followup&&!(question&&questionWording))return null;
  let location:DeliveryLocation={municipality:null,area:null};
  if(mentioned.length===1){
    const name=mentioned[0]!;
    const cities=['Medellín',...deliveryCoveragePolicy.coveredMunicipalities,...deliveryCoveragePolicy.outsideMunicipalities] as string[];
    location=cities.includes(name)?{municipality:name,area:null}:{municipality:null,area:name};
  }else if(question&&mentioned.length===0){
    // Only permit historical places for a referential follow-up, not a new unknown place.
    const evidence=/\b(ahi|alla|esa zona|ese sector)\b/.test(text)
      ? [message,...history.filter(h=>h.role==='user').slice(-2).map(h=>h.text)].join('\n') : message;
    if(literalLocation(question,evidence))location=question;
  }else if(mentioned.length===2&&mentioned.includes('Medellín')){
    location={municipality:'Medellín',area:mentioned.find(n=>n!=='Medellín')!};
  }
  const coverage=assessDeliveryCoverage(location);
  if(coverage.status==='outside')return `No, no tenemos domicilio a ${coverage.label}. Puedes coordinar recogida en El Poblado o enviar tu propio mensajero. Te comparto el mapa de cobertura.`;
  if(coverage.status==='inside')return `Sí, ${coverage.label} está en nuestra zona de domicilios. Te comparto el mapa; si estás cerca del límite, el equipo debe revisar la dirección.`;
  if(location.area)return '¿Cuál es el nombre del barrio?';
  if(generic)return 'Sí, hacemos domicilios dentro de la zona del mapa. ¿Cuál es el nombre del barrio?';
  return 'Esta es nuestra zona de domicilios. ¿Cuál es el nombre del barrio?';
}

// Conservative fallbacks for literal answers. No extraction from questions,
// negation, hypotheses, building names or mixed food/location instructions.
export function literalAddress(message:string):string|null {
 const value=message.trim();
 if(value.length>600||/[¿?]/.test(value)||/\b(si|ejemplo|seria|podria)\b/.test(norm(value)))return null;
 return /^(?:(?:mi |la )?direcci[oó]n\s+es\s+|es en |vivo en )?(?:cr\.?|cra\.?|carrera|cl\.?|cll\.?|calle|transversal|diagonal|avenida)\s*\d/i.test(value)&&/\d.*\d/.test(value)?value:null;
}
export function destinationStatement(message:string):DeliveryLocation|null {
 const value=norm(message).replace(/^(?:(?:mi |la )?direccion es |(?:estoy|vivo|es|queda) en |(?:en|barrio) )/,'');
 if(/[¿?]/.test(message))return null;
 const name=canonical(value);
 if(name){const cities=['Medellín',...deliveryCoveragePolicy.coveredMunicipalities,...deliveryCoveragePolicy.outsideMunicipalities] as string[];
 const literal=message.trim().replace(/^(?:(?:mi |la )?direcci[oó]n es |(?:estoy|vivo|es|queda) en |(?:en|barrio) )/i,'');
 return cities.includes(name)?{municipality:literal,area:null}:{municipality:null,area:literal};}
 const address=literalAddress(message);
 if(address){const location=locationFromAddress(address);if(location.municipality||location.area)return location;}
 return null;
}
