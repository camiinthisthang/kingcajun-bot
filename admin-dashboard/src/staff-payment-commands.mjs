// An amount on the owner's command is a NEW installment to add to prior payments.
// Webhook retries are deduplicated by event ID; a distinct message is a new payment.
export function copAmount(value){
 const s=String(value??'').trim().toLowerCase().replace(/\bcop\b|pesos|\$/g,'').replace(/\s/g,'');
 const match=s.match(/^(\d+(?:[.,]\d+)*)(mil|k)?$/);if(!match)return null;
 let numeric=match[1];
 if(match[2])numeric=numeric.replace(',','.');
 else if(/^[\d.,]+[.,]00$/.test(numeric)&&/[.,]/.test(numeric.slice(0,-3)))numeric=numeric.slice(0,-3).replace(/[.,]/g,'');
 else if(/^\d{1,3}(?:[.,]\d{3})+$/.test(numeric))numeric=numeric.replace(/[.,]/g,'');
 else if(!/^\d+$/.test(numeric))return null;
 const n=Number(numeric)*(match[2]?1000:1);
 return Number.isSafeInteger(n)&&n>0&&n<=2147483647?n:null;
}
export function staffPaymentCommand(text){
 const value=String(text).trim().replace(/[.!]+$/,'').trim();
 const m=value.match(/^(?:listo[,! ]*)?confirm(?:a(?:do)?|o)(?:\s+(kc-[a-z0-9]+))?(?:\s+((?:COP\s*)?\$?\s*\d[\d., ]*(?:mil|k|pesos|COP)?))?[.! ]*$/i);
 if(!m)return null;
 const amountCop=m[2]?copAmount(m[2]):null;
 if(m[2]&&!amountCop)return null;
 return {reference:m[1]?.toUpperCase()??null,amountCop};
}

export function quotedCopAmount(text,amount){
 const matches=String(text).match(/(?:COP\s*)?\$?\s*\d[\d.,]*(?:\s*(?:mil|k|pesos|COP))?/gi)??[];
 return matches.some(value=>copAmount(value)===amount);
}
export function paymentAssertion(text){
 const s=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(/[?¿]/.test(s)||/\b(no|aun|todavia|voy a|vas a|debes|debe|necesito|necesitamos|por favor|para mantener|para reservar|antes de|si ya pagaste)\b/.test(s))return false;
 return /\b(envie|enviados|transferi|consigne|pague|abone|recibi|recibimos|recibido|recibida|llego|entraron|hice (?:el|un|la|una) (?:pago|abono|transferencia)|realice (?:el|un|la|una) (?:pago|abono|transferencia))\b/.test(s)
  ||/\b(?:pago|abono|transferencia)\s+(?:realizado|realizada|enviado|enviada|recibido|recibida|exitoso|exitosa)\b/.test(s);
}
