import {randomUUID, createHash} from 'node:crypto';
import webpush from 'web-push';
import {runTicketStory,stories,workflow} from './pos/runtime.mjs';
import {enqueueTicketEvent} from './pos/jobs.mjs';

export class TableError extends Error {
  constructor(message,status=400,code='invalid_request'){super(message);this.status=status;this.code=code;}
}
const check=(value,message,status,code)=>{if(!value)throw new TableError(message,status,code);};
const clean=(value,max,label)=>{check(typeof value==='string'&&value.trim().length<=max,`${label}: texto inválido.`);return value.trim();};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const complete=['served','cancelled'];
const transitions={new:['cooking','cancel_requested'],cooking:['ready','cancel_requested'],ready:['served','cancel_requested'],cancel_requested:['cancelled'],served:[],cancelled:[]};

export async function migrateTableService(db){
  await db.exec(`
    CREATE TABLE IF NOT EXISTS dine_in_control(id INTEGER PRIMARY KEY CHECK(id=1), push_keys JSONB);
    INSERT INTO dine_in_control(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS dine_in_visits(id UUID PRIMARY KEY,table_no INTEGER NOT NULL CHECK(table_no BETWEEN 1 AND 12),opened_at TIMESTAMPTZ NOT NULL,closed_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX IF NOT EXISTS dine_in_one_open_visit ON dine_in_visits(table_no) WHERE closed_at IS NULL;
    CREATE TABLE IF NOT EXISTS dine_in_tickets(id SERIAL PRIMARY KEY,visit_id UUID NOT NULL REFERENCES dine_in_visits(id),round INTEGER NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,waiter TEXT NOT NULL,notes TEXT NOT NULL,items JSONB NOT NULL,device_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,cancel_reason TEXT NOT NULL DEFAULT '',UNIQUE(visit_id,round));
    CREATE TABLE IF NOT EXISTS dine_in_requests(key TEXT PRIMARY KEY,hash TEXT NOT NULL,response JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS dine_in_events(id SERIAL PRIMARY KEY,ticket_id INTEGER NOT NULL REFERENCES dine_in_tickets(id),action TEXT NOT NULL,detail TEXT NOT NULL,at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS dine_in_subscriptions(endpoint TEXT PRIMARY KEY,device_id UUID NOT NULL,subscription JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS dine_in_push(id SERIAL PRIMARY KEY,ticket_id INTEGER NOT NULL REFERENCES dine_in_tickets(id),endpoint TEXT NOT NULL REFERENCES dine_in_subscriptions(endpoint) ON DELETE CASCADE,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TIMESTAMPTZ NOT NULL DEFAULT now(),lease UUID,UNIQUE(ticket_id,endpoint));
    CREATE INDEX IF NOT EXISTS dine_in_push_pending ON dine_in_push(state,next_at);
  `);
}

// The dining-room menu follows the live catalog. The owner explicitly restored
// the personal snow-crab combo for table service without changing WhatsApp availability.
export async function tableCatalog(db){
  const rows=(await db.query(`SELECT slug,name,description,category,price_cop,metadata_json,pricing_spec,active FROM menu_items
    WHERE (active=TRUE OR slug='combo_personal') AND slug IS NOT NULL ORDER BY sort_order,slug`)).rows;
  const items=rows.filter(r=>Number.isSafeInteger(Number(r.price_cop))&&Number(r.price_cop)>0).map(r=>{
    const p=r.metadata_json?.kitchen?.product;
    const section=r.pricing_spec?.section;
    const category=['Combo','Marisco','Acompañante','Adición','Bebida'].includes(section)?section:r.category==='drink'?'Bebida':r.slug.startsWith('combo_')?'Combo':r.category==='plate'?'Marisco':'Adición';
    return {id:r.slug,name:r.name,description:r.description||'',priceCop:Number(r.price_cop),category,
      portion:p?.unit==='g'?`${p.baseQuantity||100} g`:r.category==='drink'?'unidad':'porción',heat:Boolean(p?.requiresHeat),
      recipe:p?{components:p.components,ingredients:r.metadata_json.kitchen.ingredients,baseQuantity:p.baseQuantity,unit:p.unit}:null};
  });
  const version=createHash('sha256').update(JSON.stringify(items)).digest('hex');
  return {source:'Menú actual de King Cajun',version,items};
}

export function createTableStore(db,getCatalog=tableCatalog,{onto=false,compiled=workflow}={}){
  const ticket=async(id,tx=db)=>(await tx.query('SELECT t.*,v.table_no FROM dine_in_tickets t LEFT JOIN dine_in_visits v ON v.id=t.visit_id WHERE t.id=$1',[id])).rows[0];
  async function action(kind,body,work){
    check(body&&typeof body==='object'&&!Array.isArray(body),'Solicitud inválida.');
    check(typeof body.requestId==='string'&&/^[\w-]{16,100}$/.test(body.requestId),'Falta el identificador de envío.');
    const hash=createHash('sha256').update(JSON.stringify([kind,body])).digest('hex');
    return db.transaction(async tx=>{
      // One brief write lock serializes table visits and retries across replicas.
      await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR UPDATE');
      const previous=(await tx.query('SELECT * FROM dine_in_requests WHERE key=$1',[body.requestId])).rows[0];
      if(previous){check(previous.hash===hash,'Este envío ya existe con otros datos.',409);return previous.response;}
      const result=await work(tx,new Date().toISOString());
      await tx.query('INSERT INTO dine_in_requests(key,hash,response) VALUES($1,$2,$3::jsonb)',[body.requestId,hash,JSON.stringify(result)]);
      return result;
    });
  }
  const event=(tx,id,name,detail,now)=>tx.query('INSERT INTO dine_in_events(ticket_id,action,detail,at) VALUES($1,$2,$3,$4)',[id,name,detail,now]);
  return {
    ticket,
    async state(){
      return db.transaction(async tx=>{
        await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR SHARE');
        return {visits:(await tx.query('SELECT * FROM dine_in_visits WHERE closed_at IS NULL ORDER BY table_no')).rows,
          tickets:(await tx.query(`SELECT t.*,v.table_no FROM dine_in_tickets t LEFT JOIN dine_in_visits v ON v.id=t.visit_id WHERE v.closed_at IS NULL OR t.id IN(SELECT id FROM dine_in_tickets ORDER BY id DESC LIMIT 100) ORDER BY t.id DESC`)).rows,
          serverTime:new Date().toISOString()};
      });
    },
    async history(id){check(await ticket(id),'Comanda no encontrada.',404);return (await db.query('SELECT * FROM dine_in_events WHERE ticket_id=$1 ORDER BY id',[id])).rows;},
    create(body,actor){return action('create',body,async(tx,now)=>{
      check(Number.isInteger(body.table)&&body.table>=1&&body.table<=12,'Elige una mesa entre 1 y 12.');
      check(uuid(body.deviceId),'Abre la aplicación en este dispositivo.');
      const waiter=clean(onto?actor?.name??'':body.waiter??'',50,'Mesera');check(waiter,'Escribe el nombre de la mesera.');
      const notes=clean(body.notes??'',500,'Nota');
      const catalog=await getCatalog(tx);
      check(body.catalogVersion===catalog.version,'El menú cambió. Revisa los platos y precios antes de enviar.',409,'catalog_changed');
      check(Array.isArray(body.items)&&body.items.length>0&&body.items.length<=40,'Agrega entre 1 y 40 líneas.');
      const items=body.items.map(item=>{
        check(item&&typeof item==='object','Producto inválido.');
        const p=catalog.items.find(p=>p.id===item.productId);check(p,'Producto no disponible.');
        check(Number.isInteger(item.quantity)&&item.quantity>=1&&item.quantity<=30,'Cantidad inválida (1–30).');
        check(!p.heat||['Suave','Medio'].includes(item.heat),'Elige el picante.');
        return {productId:p.id,name:p.name,quantity:item.quantity,portion:p.portion,priceCop:p.priceCop,heat:p.heat?item.heat:'',notes:clean(item.notes??'',300,'Nota del producto'),recipe:p.recipe,description:p.description};
      });
      let visit=(await tx.query('SELECT * FROM dine_in_visits WHERE table_no=$1 AND closed_at IS NULL',[body.table])).rows[0];
      check((body.visitId??null)===(visit?.id??null),'La mesa cambió. Revisa la visita actual antes de enviar.',409,'visit_changed');
      if(!visit){visit={id:randomUUID()};await tx.query('INSERT INTO dine_in_visits(id,table_no,opened_at) VALUES($1,$2,$3)',[visit.id,body.table,now]);}
      const round=Number((await tx.query('SELECT COUNT(*) AS n FROM dine_in_tickets WHERE visit_id=$1',[visit.id])).rows[0].n)+1;
      const id=(await tx.query(`INSERT INTO dine_in_tickets(visit_id,round,state,version,waiter,notes,items,device_id,created_at,updated_at)
        VALUES($1,$2,'new',1,$3,$4,$5::jsonb,$6,$7,$7) RETURNING id`,[visit.id,round,waiter,notes,JSON.stringify(items),body.deviceId,now])).rows[0].id;
      if(onto){await runTicketStory(tx,{id},'Waiter creates Ticket',actor,{creating:true,fields:{reference:String(id),channel:'table'},compiled});await enqueueTicketEvent(tx,await ticket(id,tx),'new');}
      await event(tx,id,'created',`Ronda ${round} · ${waiter}`,now);return ticket(id,tx);
    });},
    transition(id,body,actor){return action(`ticket:${id}`,body,async(tx,now)=>{
      const t=await ticket(id,tx);check(t,'Comanda no encontrada.',404);
      check(body.version===t.version,'La comanda cambió. Actualiza y vuelve a revisar.',409);
      if(!onto)check(transitions[t.state]?.includes(body.state),'Este cambio de estado no está permitido.',409);
      let nextState=body.state;
      if(onto){const story=body.state==='served'&&t.source_order_id?'Waiter delivers Ticket':stories[body.state];check(story,'Acción inválida.');const result=await runTicketStory(tx,t,story,actor,{compiled});nextState=result.status;}
      const reason=body.state==='cancel_requested'?clean(body.reason??'',300,'Motivo'):t.cancel_reason;
      check(body.state!=='cancel_requested'||reason.length>0,'Escribe el motivo de cancelación.');
      await tx.query('UPDATE dine_in_tickets SET state=$1,version=version+1,updated_at=$2,cancel_reason=$3 WHERE id=$4',[nextState,now,reason,id]);
      if(body.state==='ready')await tx.query(`INSERT INTO dine_in_push(ticket_id,endpoint) SELECT $1,endpoint FROM dine_in_subscriptions WHERE device_id=$2 ON CONFLICT DO NOTHING`,[id,t.device_id]);
      if(onto){const updated=await ticket(id,tx);if(body.state!=='approved')await enqueueTicketEvent(tx,updated,nextState);if(t.source_order_id&&['served','cancelled'].includes(nextState)){await tx.query("UPDATE orders SET status=$2,updated_at=$3,refund_status=CASE WHEN $2='cancelled' AND EXISTS(SELECT 1 FROM payments WHERE order_id=$1 AND status='confirmed') THEN 'pending' ELSE refund_status END WHERE id=$1",[t.source_order_id,nextState==='served'?'fulfilled':'cancelled',now]);}}
      await event(tx,id,body.state,`${actor?.name??''} · ${reason||body.state}`,now);return ticket(id,tx);
    });},
    closeVisit(id,body,actor){if(onto)check(actor?.roles?.includes('Waiter'),'Esta acción requiere permiso de servicio.',403);check(uuid(id),'Visita inválida.');return action(`close:${id}`,body,async(tx,now)=>{
      const v=(await tx.query('SELECT * FROM dine_in_visits WHERE id=$1',[id])).rows[0];check(v&&!v.closed_at,'Esta visita ya terminó.',409);
      const tickets=(await tx.query('SELECT state FROM dine_in_tickets WHERE visit_id=$1',[id])).rows;
      check(tickets.length&&tickets.every(t=>complete.includes(t.state)),'Primero entrega o confirma la cancelación de todas las comandas.',409);
      await tx.query('UPDATE dine_in_visits SET closed_at=$1 WHERE id=$2',[now,id]);return {id,closedAt:now};
    });},
    async pushConfig(subject){
      return db.transaction(async tx=>{
        const row=(await tx.query('SELECT push_keys FROM dine_in_control WHERE id=1 FOR UPDATE')).rows[0];
        let keys=row.push_keys;if(!keys){keys=webpush.generateVAPIDKeys();await tx.query('UPDATE dine_in_control SET push_keys=$1::jsonb WHERE id=1',[JSON.stringify(keys)]);}
        return {subject,...keys};
      });
    },
    async subscribe(deviceId,subscription){
      check(uuid(deviceId),'Dispositivo inválido.');
      let endpoint;try{endpoint=new URL(subscription?.endpoint);}catch{throw new TableError('Suscripción inválida.');}
      const allowed=endpoint.hostname==='fcm.googleapis.com'||endpoint.hostname.endsWith('.push.apple.com')||endpoint.hostname==='updates.push.services.mozilla.com';
      check(allowed&&endpoint.protocol==='https:'&&!endpoint.username&&!endpoint.password&&!endpoint.port&&endpoint.href.length<3000,'Proveedor de notificaciones no permitido.');
      check(typeof subscription.keys?.p256dh==='string'&&/^[\w-]{87}$/.test(subscription.keys.p256dh)&&typeof subscription.keys?.auth==='string'&&/^[\w-]{22}$/.test(subscription.keys.auth),'Claves de suscripción inválidas.');
      const saved={endpoint:endpoint.href,keys:subscription.keys};
      return db.transaction(async tx=>{
        await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR UPDATE');
        const old=(await tx.query('SELECT device_id FROM dine_in_subscriptions WHERE endpoint=$1',[endpoint.href])).rows[0];
        check(!old||old.device_id===deviceId,'Esta suscripción pertenece a otro dispositivo.',409);
        await tx.query('INSERT INTO dine_in_subscriptions VALUES($1,$2,$3::jsonb) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription',[endpoint.href,deviceId,JSON.stringify(saved)]);
        return {subscribed:true};
      });
    },
    async unsubscribe(deviceId,endpoint){await db.query('DELETE FROM dine_in_subscriptions WHERE device_id=$1 AND endpoint=$2',[deviceId,endpoint]);return {subscribed:false};},
    async claimPush(){return db.transaction(async tx=>{
      await tx.query("UPDATE dine_in_push SET state='skipped',lease=NULL WHERE state='pending' AND ticket_id IN(SELECT id FROM dine_in_tickets WHERE state<>'ready')");
      const rows=(await tx.query(`SELECT p.*,s.subscription FROM dine_in_push p JOIN dine_in_subscriptions s ON s.endpoint=p.endpoint
        WHERE p.state='pending' AND p.next_at<=now() ORDER BY p.id LIMIT 5 FOR UPDATE OF p SKIP LOCKED`)).rows;
      for(const row of rows){row.lease=randomUUID();await tx.query("UPDATE dine_in_push SET lease=$1,next_at=now()+interval '60 seconds' WHERE id=$2",[row.lease,row.id]);row.ticket=await ticket(row.ticket_id,tx);}
      return rows;
    });},
    async pushResult(job,result){
      if(result==='gone'){await db.query('DELETE FROM dine_in_subscriptions WHERE endpoint=$1',[job.endpoint]);return;}
      const attempts=job.attempts+1,state=result==='accepted'?'accepted':attempts>=8?'failed':'pending';
      await db.query('UPDATE dine_in_push SET state=$1,attempts=$2,next_at=$3,lease=NULL WHERE id=$4 AND lease=$5',[state,attempts,new Date(Date.now()+Math.min(60000,2000*2**attempts)).toISOString(),job.id,job.lease]);
    }
  };
}

export function tablePushDispatcher(store,config,send=webpush.sendNotification.bind(webpush)){
  let running=false;
  return async()=>{
    if(running||!config)return;running=true;
    try{for(const job of await store.claimPush()){
      if((await store.ticket(job.ticket_id))?.state!=='ready')continue;
      const t=job.ticket,payload=JSON.stringify({title:`Mesa ${t.table_no} lista`,body:`Comanda #${t.id} · ronda ${t.round}. Recoge el pedido en cocina.`,ticketId:t.id,table:t.table_no});
      try{await send(job.subscription,payload,{vapidDetails:config,TTL:300,urgency:'high',topic:`kc-ready-${t.id}`,timeout:8000});await store.pushResult(job,'accepted');}
      catch(e){await store.pushResult(job,[404,410].includes(e.statusCode)?'gone':'retry');}
    }}finally{running=false;}
  };
}
