// Shared by the dashboard and the WhatsApp runtime. Never store prices in copy.
export class FlowError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const field=(id,group,label,text,tokens=[],required=tokens)=>({id,group,label,text,tokens,required});
export const flowFields=[
 {...field('main_menu','Main menu','Greeting above the buttons','¡Hola! 🦞 Bienvenido a King Cajun. ¿Qué quieres hacer?\n\nElige una opción. Puedes escribir MENÚ para volver aquí.'),maxLength:1024},
 {...field('main_menu_order','Main menu','Button: starts the ordering flow','Hacer pedido'),maxLength:20},
 {...field('main_menu_catalog','Main menu','Button: shows the food menu','Ver menú'),maxLength:20},
 {...field('main_menu_human','Main menu','Button: pauses the bot for your team','Hablar con alguien'),maxLength:20},
 field('human_handoff','Main menu','Reply when someone chooses your team','Puedes dejar tu mensaje aquí para el equipo. El asistente de pedidos queda pausado. Para volver, escribe MENÚ o HACER PEDIDO. Esto no cancela pedidos ya confirmados.'),
 {...field('ordering_intro','Welcome','AI ordering · short introduction','🦀 *Entregas programadas para el fin de semana, no inmediatas.*\n\n*Cupos disponibles:*\n{{cupos-disponibles}}\n\nTú eliges la fecha y el horario. ¿Qué combo o mariscos quieres? Picante: suave o medio.',['cupos-disponibles']),maxLength:450},
 field('welcome','Welcome','Welcome & ordering instructions','*Así funcionan nuestros prepedidos*\n• Solo hacemos entregas en fechas y franjas programadas.\n• Tu pedido debe pagarse al momento de hacerlo.\n• Puedes cancelarlo hasta 12 horas antes del inicio de tu franja. Escribe CANCELAR y la referencia del pedido.\n\n{{schedule}}\n\n*¿Qué quieres pedir?*\nCuando termines, escribe *LISTO*.',['schedule','proxima-franja','cupos-disponibles'],[]),
 field('extras_referral','Extras','Optional referral alongside extras','Si tienes un código de referido, puedes incluirlo aquí. Ejemplo: CÓDIGO TU-CODIGO. Puedes enviarlo junto con tus extras.'),
 field('deposit_required','Confirmation','Order received · reservation deposit','🧾 *Pedido recibido · pendiente de abono*\n\n• Pedido: {{reference}}\n\n*Tu pedido*\n{{items}}\n\n*Entrega*\n{{delivery}}\n{{referral}}\n\n*Total: {{total}}*\n*Abono para reservar: {{deposit}}*\n*Saldo contra entrega después del abono: {{balance}}*\n\n{{instructions}}\n\nEl abono es reembolsable si cancelas al menos 12 horas antes del inicio de tu franja de entrega.',['reference','items','delivery','referral','total','deposit','balance','instructions'],['reference','items','delivery','total','deposit','balance','instructions']),
 field('order_confirmed','Confirmation','Final confirmation · payment on delivery','✅ *Pedido confirmado*\n\n• Pedido: {{reference}}\n\n*Tu pedido*\n{{items}}\n\n*Entrega*\n{{delivery}}\n{{referral}}\n\n*Total a pagar contra entrega: {{total}}*\n\n¡Gracias por pedir en King Cajun!',['reference','items','delivery','referral','total'],['reference','items','delivery','total']),
 field('menu','Welcome','Menu introduction','*Menú King Cajun*\n\n{{items}}',['items']),
 field('schedule','Welcome','Open delivery date','*Próxima entrega*\n• {{delivery}}\n\n*Fecha límite para pedir y pagar*\n• {{cutoff}}',['delivery','cutoff']),
 field('closed','Welcome','No open delivery date','Todavía no hay una fecha abierta. Te avisaremos cuando publiquemos la siguiente.'),
 field('needs_item','Order','Empty order','Elige al menos un combo o marisco del menú actual.'),
 field('unknown_item','Order','Product not understood','No identifiqué un producto. Escribe su nombre tal como aparece en el menú, o REINICIAR para verlo de nuevo.'),
 field('extras_first','Order','Extras added before a main item','Agregamos {{items}}. Ahora dime qué combo o mariscos quieres, o escribe *LISTO* si ya habías elegido tu plato.',['items']),
 field('sauce','Order','Sauce question (legacy menu only)','{{options}}',['options']),
 field('invalid_sauce','Order','Sauce not understood','No reconocí esa salsa. {{options}}',['options']),
 field('spice','Order','Spice question','¿Qué nivel de picante prefieres?\n{{options}}',['options']),
 field('invalid_spice','Order','Spice not understood','No reconocí ese nivel. {{options}}',['options']),
 field('added','Order','Item added','✅ *Agregado a tu pedido*\n\n{{items}}\n• Salsa: {{sauce}}\n• Picante: {{spice}}',['items','sauce','spice']),
 field('upsell','Extras','Offer extras','*¿Quieres completar tu pedido?*\n\n{{items}}\n\nEscribe el nombre del extra o responde *NO* para continuar.',['items']),
 field('upsell_empty','Extras','No extras to suggest','Cuando termines, escribe *LISTO*.'),
 field('invalid_extra','Extras','Extra not understood','No reconocí ese extra. Elige uno del menú o responde *NO*.\n{{items}}',['items']),
 field('extras_added','Extras','Extra added','✅ Agregamos:\n{{items}}',['items']),
 field('delivery','Delivery','Choose delivery & address','*Elige la franja y envíanos tu dirección*\n\n{{windows}}\n\n*Responde en un solo mensaje con el número y la dirección.*\n_Ejemplo: 1, Calle 10 #43-20, Medellín_',['windows']),
 field('no_windows','Delivery','Delivery full or closed','No quedan franjas de entrega abiertas. Escribe *REINICIAR* para consultar nuevamente.'),
 field('address','Delivery','Ask for missing address','Elegiste:\n• {{delivery}}\n\nAhora envía la dirección completa, incluyendo barrio y detalles de acceso.',['delivery']),
 field('invalid_address','Delivery','Incomplete address','Necesito una dirección un poco más completa. Inténtalo de nuevo.'),
 field('referral','Referral','Referral question','*Código de referido*\n\nSi tienes el código de un creador o influencer, escríbelo ahora. Si no tienes, responde *NO*.'),
 field('invalid_referral','Referral','Unknown referral code','Ese código no existe o no está activo. Revisa e intenta otra vez, o responde *NO*.'),
 field('review','Confirmation','Order summary','*Revisa tu prepedido*\n\n*Pedido*\n{{items}}\n\n*Entrega*\n{{delivery}}\n{{referral}}\n\n*Total: {{total}}*',['items','delivery','referral','total'],['items','delivery','total']),
 field('confirm','Confirmation','Ask for confirmation','{{summary}}\n\nAbre el mapa y verifica que el punto corresponda a tu dirección.\n\nResponde *SÍ* para crear el prepedido o *NO* para empezar de nuevo.',['summary']),
 field('invalid_confirmation','Confirmation','Confirmation not understood','Responde *SÍ* para confirmar o *NO* para empezar de nuevo.'),
 field('payment','Confirmation','Order created & transfer instructions','🧾 *Prepedido creado*\n\n• Pedido: {{reference}}\n• Total: {{total}}\n• Estado: Pendiente de pago\n\n*Instrucciones de pago*\n{{instructions}}\n\n{{verification}} Puedes cancelar hasta 12 horas antes del inicio de tu franja con CANCELAR {{reference}}.',['reference','total','instructions','verification']),
 field('status','Help','Order status','Pedido {{reference}}: {{status}}. Total: {{total}}.',['reference','status','total']),
 field('cancel_help','Help','Cancellation instructions','Para cancelar un pedido escribe *CANCELAR KC-XXXXXX* con su referencia. Puedes cancelarlo hasta 12 horas antes del inicio de la franja. Para borrar solo el carrito escribe *REINICIAR*.'),
 field('cancelled','Help','Cancellation confirmed','Pedido {{reference}} cancelado. No se preparará.{{refund}}',['reference','refund']),
 field('error','Help','Error message','No pude procesar eso: {{error}}. Escribe REINICIAR para volver a empezar.',['error'])
];
export const defaultFlow=()=>({messages:Object.fromEntries(flowFields.map(f=>[f.id,f.text])),steps:{upsell:true,referral:true}});
export const mainMenuFieldIds=flowFields.filter(f=>f.group==='Main menu').map(f=>f.id);
// Add fields introduced after the first editor without replacing saved wording.
export function upgradeFlow(document){
 const result={...document,messages:{...Object.fromEntries(flowFields.filter(f=>f.group==='Main menu'||['ordering_intro','extras_referral','order_confirmed','deposit_required'].includes(f.id)).map(f=>[f.id,f.text])),...document.messages}};
 const oldIntro='🦀 ¡Vamos con tu pedido!\nPróxima entrega: {{proxima-franja}}\n\nDime qué combo o mariscos quieres y cuántos. Picante: suave o medio.';
 const oldShortIntro='🦀 ¡Vamos con tu pedido!\nDime qué combo o mariscos quieres y cuántos. Picante: suave o medio.\nLuego eliges la fecha y el horario de entrega.';
 if([oldIntro,oldShortIntro].includes(result.messages.ordering_intro))result.messages.ordering_intro=flowFields.find(f=>f.id==='ordering_intro').text;
 const confirmation=flowFields.find(f=>f.id==='order_confirmed').text;
 if(result.messages.order_confirmed===confirmation+' No necesitas responder a este mensaje.')result.messages.order_confirmed=confirmation;
 return result;
}
export function validateFlow(document){
 if(!document||typeof document!=='object'||!document.messages||!document.steps)throw new FlowError('Missing messages or steps.');
 document=upgradeFlow(document);
 const result=defaultFlow();
 for(const f of flowFields){
  const text=document.messages[f.id];
  const limit=f.maxLength??3500;
  if(typeof text!=='string'||!text.trim()||text.length>limit)throw new FlowError(`${f.label}: enter 1–${limit} characters.`);
  if(limit===20&&/[\n\r]/.test(text))throw new FlowError(`${f.label}: use a single line.`);
  const tokens=[...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(m=>m[1]);
  if(tokens.some(t=>!f.tokens.includes(t)))throw new FlowError(`${f.label}: unknown automatic value.`);
  if(f.id==='welcome'&&!tokens.some(t=>['schedule','proxima-franja','cupos-disponibles'].includes(t)))throw new FlowError('Welcome & ordering instructions: keep {{schedule}}, {{proxima-franja}} or {{cupos-disponibles}} so the customer receives the delivery date.');
  if(f.required.some(t=>!tokens.includes(t)))throw new FlowError(`${f.label}: keep ${f.required.map(t=>'{{'+t+'}}').join(', ')} so the customer receives the order details.`);
  if(text.replace(/{{\s*[^{}]+?\s*}}/g,'').includes('{{')||text.replace(/{{\s*[^{}]+?\s*}}/g,'').includes('}}'))throw new FlowError(`${f.label}: incomplete automatic value.`);
  result.messages[f.id]=text;
 }
 const labels=['main_menu_order','main_menu_catalog','main_menu_human'].map(key=>result.messages[key].trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim());
 if(labels.some(label=>!label||['menu','menu principal','salir','reiniciar','empezar','estado','cancelar'].includes(label))||new Set(labels).size!==3)throw new FlowError('Use three distinct button labels, different from the MENU, SALIR, REINICIAR, ESTADO and CANCELAR commands.');
 for(const key of ['upsell','referral']){if(typeof document.steps[key]!=='boolean')throw new FlowError('Invalid step setting.');result.steps[key]=document.steps[key];}
 return result;
}
export function renderFlow(document,key,values={}){
 const template=document.messages[key];if(typeof template!=='string')throw new Error('Unknown flow message: '+key);
 return template.replace(/{{\s*([^{}]+?)\s*}}/g,(_,token)=>{if(values[token]===undefined)throw new Error('Missing flow value: '+token);return String(values[token]);});
}
export async function migrateFlow(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS bot_flow (
 id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0,
 draft JSONB NOT NULL, published JSONB NOT NULL, published_version INTEGER NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ);
 CREATE TABLE IF NOT EXISTS bot_flow_history(version INTEGER PRIMARY KEY, document JSONB NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
 await db.query('INSERT INTO bot_flow(id,draft,published) VALUES(1,$1::jsonb,$1::jsonb) ON CONFLICT DO NOTHING',[JSON.stringify(defaultFlow())]);
}
export async function readFlow(db){const row=(await db.query('SELECT version,draft,published,published_version,updated_at,published_at FROM bot_flow WHERE id=1')).rows[0];return {...row,draft:upgradeFlow(row.draft),published:upgradeFlow(row.published)};}
export async function saveFlow(db,input,actor){
 const document=validateFlow(input.document);
 return db.transaction(async tx=>{
  const r=await tx.query('UPDATE bot_flow SET draft=$1::jsonb,version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING version',[JSON.stringify(document),input.version]);
  if(!r.rowCount)throw new FlowError('Another edit was saved. Your text is still here; export it before reloading.',409);
  await tx.query('INSERT INTO bot_flow_history(version,document,action,actor) VALUES($1,$2::jsonb,$3,$4)',[r.rows[0].version,JSON.stringify(document),'draft',actor]);
  return readFlow(tx);
 });
}
export async function publishFlow(db,input,actor){
 const scope=input.scope??'all';
 if(!['all','main_menu','ordering'].includes(scope))throw new FlowError('Invalid publishing scope.');
 return db.transaction(async tx=>{
  const row=(await tx.query('SELECT * FROM bot_flow WHERE id=1 FOR UPDATE')).rows[0];
  if(row.version!==input.version)throw new FlowError('The saved draft changed. Reload before using this version.',409);
  const draft=validateFlow(row.draft),published=upgradeFlow(row.published);
  const document=structuredClone(published);
  for(const f of flowFields){if(scope==='all'||(scope==='main_menu')===mainMenuFieldIds.includes(f.id))document.messages[f.id]=draft.messages[f.id];}
  if(scope!=='main_menu')document.steps=draft.steps;
  const version=row.version+1;
  await tx.query('UPDATE bot_flow SET published=$2::jsonb,version=$1,published_version=$1,published_at=now(),updated_at=now() WHERE id=1',[version,JSON.stringify(document)]);
  await tx.query('INSERT INTO bot_flow_history(version,document,action,actor) VALUES($1,$2::jsonb,$3,$4)',[version,JSON.stringify(document),scope==='all'?'publish':'publish:'+scope,actor]);
  return readFlow(tx);
 });
}
