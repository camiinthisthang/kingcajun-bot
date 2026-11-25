import {randomUUID,createHash} from 'node:crypto';
import {DateTime} from 'luxon';
import {parseProjectFiles} from '@trigramco/ontolang';
import {compileModel,executeStory} from '@trigramco/ontolang/runtime';
import {source} from './scheduled-model.mjs';

export const ZONE='America/Bogota';
export const policy={notice:60,driverMinutes:75,arrivalMinutes:20,night:12,group:3,nearbyKm:2};
export function compileScheduling(text=source){return {model:compileModel(parseProjectFiles('scheduled-orders',{'project.onto':text})),revision:createHash('sha256').update(text).digest('hex')};}
const compiled=compileScheduling();
const fail=message=>{throw Object.assign(Error(message),{status:409});};
export function schedulingDecision(fields,workflow=compiled){
 const before={instances:[{id:'bot',type:'OrderBot',fields:{}},{id:'booking',type:'Booking',fields:{...fields,status:'proposed'}}],now:new Date().toISOString()};
 const input={story:'OrderBot reserves Booking',actor:'bot',object:'booking'};
 const result=executeStory(workflow.model,before,input);
 return {before,input,result,revision:workflow.revision};
}
export async function migrateScheduledOrders(db){await db.exec(`
 CREATE TABLE IF NOT EXISTS scheduled_order_control(id INTEGER PRIMARY KEY CHECK(id=1));
 INSERT INTO scheduled_order_control VALUES(1) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS scheduled_groups(id UUID PRIMARY KEY,service_date DATE NOT NULL,starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ NOT NULL,driver INTEGER NOT NULL CHECK(driver IN (1,2)),area TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','out','returned')),departed_at TIMESTAMPTZ,returned_at TIMESTAMPTZ);
 CREATE TABLE IF NOT EXISTS scheduled_bookings(order_id UUID PRIMARY KEY REFERENCES orders(id),group_id UUID REFERENCES scheduled_groups(id),checkout_key TEXT UNIQUE NOT NULL,phone TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('delivery','pickup')),starts_at TIMESTAMPTZ NOT NULL,lat DOUBLE PRECISION,lng DOUBLE PRECISION,address TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS scheduled_checkouts(key TEXT PRIMARY KEY,phone TEXT NOT NULL,response JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS scheduled_chats(phone TEXT PRIMARY KEY,context JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS scheduled_executions(id BIGSERIAL PRIMARY KEY,reference TEXT NOT NULL,revision TEXT NOT NULL,input JSONB NOT NULL,before_snapshot JSONB NOT NULL,after_snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 ALTER TABLE delivery_windows ADD COLUMN IF NOT EXISTS scheduled_kind TEXT;
 CREATE OR REPLACE FUNCTION guard_scheduled_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE day DATE; used INTEGER; booking RECORD; other_group RECORD;
 BEGIN
  IF COALESCE(NEW.delivery_coverage->>'method',NEW.delivery_coverage->>'preference',NEW.fulfillment_type) IN ('pickup','own_courier') THEN RETURN NEW; END IF;
  IF NOT (NEW.status IN ('confirmed','fulfilled','payment_review') OR NEW.status='awaiting_payment' AND NEW.payment_expires_at>now()) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.delivery_window_id=NEW.delivery_window_id AND COALESCE(OLD.delivery_coverage->>'method',OLD.delivery_coverage->>'preference',OLD.fulfillment_type) NOT IN ('pickup','own_courier') AND (OLD.status IN ('confirmed','fulfilled','payment_review') OR OLD.status='awaiting_payment' AND OLD.payment_expires_at>now()) THEN RETURN NEW; END IF;
  SELECT (starts_at AT TIME ZONE 'America/Bogota')::date INTO day FROM delivery_windows WHERE id=NEW.delivery_window_id;
  IF day<'2026-11-26' THEN RETURN NEW; END IF;
  PERFORM id FROM scheduled_order_control WHERE id=1 FOR UPDATE;
  SELECT count(*) INTO used FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id<>NEW.id AND (w.starts_at AT TIME ZONE 'America/Bogota')::date=day AND COALESCE(o.delivery_coverage->>'method',o.delivery_coverage->>'preference',o.fulfillment_type) NOT IN ('pickup','own_courier') AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>now());
  IF used>=12 THEN RAISE EXCEPTION 'La fecha ya tiene 12 domicilios. No se puede confirmar otro pago sin reorganizar los pedidos.'; END IF;
  SELECT g.* INTO booking FROM scheduled_bookings b JOIN scheduled_groups g ON g.id=b.group_id WHERE b.order_id=NEW.id;
  IF FOUND THEN
   IF booking.state<>'planned' THEN RAISE EXCEPTION 'La ruta ya salió. Reprograma antes de confirmar este pago.'; END IF;
   SELECT count(*) INTO used FROM scheduled_bookings b JOIN orders o ON o.id=b.order_id WHERE b.group_id=booking.id AND o.id<>NEW.id AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>now());
   IF used>=3 THEN RAISE EXCEPTION 'El grupo ya tiene 3 pedidos. Reprograma antes de confirmar este pago.'; END IF;
   FOR other_group IN SELECT g.* FROM scheduled_groups g WHERE g.id<>booking.id AND g.driver=booking.driver AND g.starts_at<GREATEST(booking.ends_at,booking.starts_at+interval '75 minutes') AND GREATEST(g.ends_at,g.starts_at+interval '75 minutes')>booking.starts_at LOOP
    IF other_group.state='out' OR EXISTS(SELECT 1 FROM scheduled_bookings b JOIN orders o ON o.id=b.order_id WHERE b.group_id=other_group.id AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>now())) THEN RAISE EXCEPTION 'El conductor ya tiene otra ruta. Reprograma antes de confirmar este pago.'; END IF;
   END LOOP;
  END IF;
  RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS scheduled_capacity_guard ON orders;
 CREATE TRIGGER scheduled_capacity_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_scheduled_capacity();
 `);}
export function localTime(value){return DateTime.fromISO(value,{zone:ZONE}).setZone(ZONE);}
export function serviceTime(kind,start,now=DateTime.now()){
 const at=localTime(start),today=now.setZone(ZONE),minutes=at.hour*60+at.minute;
 if(!at.isValid||at.toISODate()<'2026-11-26'||at.startOf('week').toISODate()!==today.startOf('week').toISODate())return false;
 if(at.second!==0||at.millisecond!==0)return false;
 if(kind==='delivery')return at.weekday>=6&&minutes>=18*60&&minutes<=22*60-policy.arrivalMinutes;
 return kind==='pickup'&&at.weekday>=4&&minutes>=(at.weekday<=5?17*60+30:16*60+30)&&minutes<=22*60;
}
export function serviceDates(kind,now=DateTime.now()){
 const today=now.setZone(ZONE).startOf('day'),days=[];
 for(let i=0;i<7;i++){const day=today.plus({days:i});if(day.startOf('week').toISODate()!==today.startOf('week').toISODate())break;
 if(day.toISODate()>='2026-11-26'&&day.weekday>=(kind==='delivery'?6:4))days.push(day.toISODate());}
 return days;
}
export function distanceKm(a,b){const rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng);return 6371*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2)));}
export function validPoint(p){return Number.isFinite(p?.lat)&&Number.isFinite(p?.lng)&&p.lat>=6.10&&p.lat<=6.35&&p.lng>=-75.68&&p.lng<=-75.48;}
const occupied=`(o.status IN ('confirmed','fulfilled','payment_review') OR (o.status='awaiting_payment' AND o.payment_expires_at>$2))`;
export async function schedulingState(db,date,now=new Date().toISOString()){
 const bookings=(await db.query(`SELECT b.*,o.status FROM scheduled_bookings b JOIN orders o ON o.id=b.order_id WHERE (b.starts_at AT TIME ZONE 'America/Bogota')::date=$1::date AND ${occupied}`,[date,now])).rows;
 const groups=(await db.query("SELECT id,service_date,starts_at,GREATEST(ends_at,starts_at+interval '75 minutes') AS ends_at,driver,area,state,departed_at,returned_at FROM scheduled_groups WHERE service_date=$1::date ORDER BY starts_at,id",[date])).rows.map(g=>({...g,points:bookings.filter(b=>b.group_id===g.id)})).filter(g=>g.points.length||g.state==='out');
 // Count ALL delivery orders, including staff/legacy ones. Pickup never consumes a driver or nightly place.
 const nightly=Number((await db.query(`SELECT count(*)::int count FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE (w.starts_at AT TIME ZONE 'America/Bogota')::date=$1::date AND COALESCE(o.delivery_coverage->>'method',o.delivery_coverage->>'preference',o.fulfillment_type) NOT IN ('pickup','own_courier') AND ${occupied}`,[date,now])).rows[0].count);
 return {groups,nightly};
}
function candidate(state,input,now){
 const start=localTime(input.startsAt),end=start.plus({minutes:policy.driverMinutes}),notice=Math.floor(start.diff(now,'minutes').minutes);
 const isDelivery=input.kind==='delivery';
 const matches=isDelivery?state.groups.filter(g=>g.state==='planned'&&+new Date(g.starts_at)===start.toMillis()&&g.area===input.area&&g.points.length<policy.group&&g.points.every(p=>distanceKm(p,input.point)<=policy.nearbyKm)):[];
 const group=matches[0];
 const driver=group?.driver??[1,2].find(d=>!state.groups.some(g=>g.driver===d&&new Date(g.starts_at)<end.toJSDate()&&new Date(g.ends_at)>start.toJSDate()));
 const fields={channel:input.kind,noticeMinutes:notice,serviceOpen:serviceTime(input.kind,input.startsAt,now),pinConfirmed:input.pinConfirmed===true&&validPoint(input.point),nightlyCount:state.nightly+1,groupCount:(group?.points.length??0)+1,driverFree:!!driver};
 const decision=schedulingDecision(fields);
 return {group,driver,start,end,decision,available:decision.result.committed};
}
export async function availableScheduledTimes(db,input,now=DateTime.now()){
 if(!serviceDates(input.kind,now).includes(input.date))return [];
 const state=await schedulingState(db,input.date,now.toUTC().toISO());
 const first=input.kind==='delivery'?18*60:localTime(input.date).weekday<=5?17*60+30:16*60+30;
 const last=input.kind==='delivery'?22*60-policy.arrivalMinutes:22*60;
 const minutes=[];for(let m=first;m<=last;m+=15)minutes.push(m);if(!minutes.includes(last))minutes.push(last);
 const starts=new Set(minutes.map(m=>localTime(input.date).set({hour:Math.floor(m/60),minute:m%60}).toUTC().toISO()));
 for(const g of state.groups)starts.add(new Date(g.starts_at).toISOString());
 if(input.requestedAt&&localTime(input.requestedAt).toISODate()===input.date)starts.add(localTime(input.requestedAt).toUTC().toISO());
 const options=[...starts].map(startsAt=>({startsAt,...candidate(state,{...input,startsAt},now)})).filter(c=>c.available);
 // Existing nearby groups first; the rest remain selectable, never silently move a customer's time.
 return options.sort((a,b)=>Number(!!b.group)-Number(!!a.group)||a.start.toMillis()-b.start.toMillis()).map(c=>({startsAt:c.startsAt,recommended:!!c.group,groupId:c.group?.id??null}));
}
export async function prepareScheduledCheckout(tx,input,phone,key,now=DateTime.now()){
 await tx.query('SELECT id FROM scheduled_order_control WHERE id=1 FOR UPDATE');
 const prior=(await tx.query('SELECT * FROM scheduled_checkouts WHERE key=$1',[key])).rows[0];
 if(prior){
  if(prior.phone!==phone)fail('Identificador de pedido inválido.');
  const o=(await tx.query('SELECT status,payment_expires_at FROM orders WHERE id=$1',[prior.response.orderId])).rows[0];
  if(!o||['cancelled','expired'].includes(o.status)||o.status==='awaiting_payment'&&new Date(o.payment_expires_at)<=now.toJSDate())throw Object.assign(Error('Esa reserva venció. Elige un horario disponible para crear una nueva.'),{code:'reservation_expired'});
  return {prior:prior.response};
 }
 if(!key||!['pickup','delivery'].includes(input.kind))fail('Revisa tu pedido.');
 if(input.kind==='delivery'&&(!input.area||!input.address||input.pinConfirmed!==true||!validPoint(input.point)))fail('Confirma primero la dirección y el punto exacto.');
 const start=localTime(input.startsAt),state=await schedulingState(tx,start.toISODate(),now.toUTC().toISO()),c=candidate(state,input,now);
 if(!c.available)fail('Ese horario ya no está disponible. Elige otro horario: necesitamos 60 minutos de anticipación y respetamos los cupos de los conductores.');
 let groupId=null;
 if(input.kind==='delivery'){
  groupId=c.group?.id??randomUUID();
  if(!c.group)await tx.query("INSERT INTO scheduled_groups(id,service_date,starts_at,ends_at,driver,area) VALUES($1,$2,$3,$4,$5,$6)",[groupId,start.toISODate(),start.toUTC().toISO(),c.end.toUTC().toISO(),c.driver,input.area]);
 }
 const windowId=randomUUID(),end=start.plus({minutes:input.kind==='delivery'?policy.arrivalMinutes:1});
 // Internal per-order windows are hidden from the legacy public checkout.
 await tx.query("INSERT INTO delivery_windows(id,fulfillment_type,starts_at,ends_at,order_opens_at,order_cutoff_at,capacity,status,created_at,scheduled_kind) VALUES($1,'delivery',$2,$3,$4,$5,1,'closed',now(),$6)",[windowId,start.toUTC().toISO(),end.toUTC().toISO(),start.startOf('week').toUTC().toISO(),start.minus({minutes:60}).toUTC().toISO(),input.kind]);
 return {windowId,groupId,decision:c.decision,start:start.toUTC().toISO(),input};
}
export async function finishScheduledCheckout(tx,prepared,orderId,phone,key,response){
 const {input,decision}=prepared;
 await tx.query('INSERT INTO scheduled_bookings(order_id,group_id,checkout_key,phone,kind,starts_at,lat,lng,address) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[orderId,prepared.groupId,key,phone,input.kind,prepared.start,input.point?.lat??null,input.point?.lng??null,input.address]);
 await tx.query('INSERT INTO scheduled_checkouts(key,phone,response) VALUES($1,$2,$3::jsonb)',[key,phone,JSON.stringify(response)]);
 await tx.query('INSERT INTO scheduled_executions(reference,revision,input,before_snapshot,after_snapshot) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[orderId,decision.revision,JSON.stringify(decision.input),JSON.stringify(decision.before),JSON.stringify(decision.result.snapshot)]);
}
export async function readScheduledGroups(db,date){
 const {groups,nightly}=await schedulingState(db,date);
 const rows=(await db.query(`SELECT b.group_id,b.kind,b.starts_at,o.public_id,o.status,o.total_cop,o.delivery_address,c.display_name,c.phone_e164,(SELECT json_agg(json_build_object('name',l.item_name_snapshot,'quantity',l.quantity)) FROM order_line_items l WHERE l.order_id=o.id) AS items FROM scheduled_bookings b JOIN orders o ON o.id=b.order_id JOIN customers c ON c.id=o.customer_id WHERE (b.starts_at AT TIME ZONE 'America/Bogota')::date=$1::date AND ${occupied}`,[date,new Date().toISOString()])).rows;
 return {date,nightly,limit:12,pickups:rows.filter(o=>o.kind==='pickup'),groups:groups.map(g=>({...g,orders:rows.filter(o=>o.group_id===g.id)}))};
}
export async function transitionScheduledGroup(db,id,action,actor,ready=false){
 if(!actor?.id||!actor.roles?.includes('Dispatcher'))throw Object.assign(Error('Solo el equipo autorizado puede despachar.'),{status:403});
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM scheduled_order_control WHERE id=1 FOR UPDATE');
  const g=(await tx.query('SELECT * FROM scheduled_groups WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!g)fail('Grupo no encontrado.');
  if(!['dispatch','return'].includes(action))fail('Acción inválida.');
  const busy=(await tx.query("SELECT id FROM scheduled_groups WHERE driver=$1 AND state='out' AND id<>$2",[g.driver,id])).rowCount>0;
  const orders=(await tx.query(`SELECT o.status,o.total_cop,(SELECT COALESCE(sum(p.amount_cop),0) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed') AS paid FROM scheduled_bookings b JOIN orders o ON o.id=b.order_id WHERE b.group_id=$1 AND o.status NOT IN ('cancelled','expired')`,[id])).rows;
  const fields={status:g.state,driverAvailable:!busy,departureDue:new Date(g.starts_at)<=new Date(),ordersReady:ready===true&&orders.length>0&&orders.every(o=>o.status==='confirmed'&&Number(o.paid)>=o.total_cop)};
  const before={instances:[{id:actor.id,type:'Person',fields:{name:actor.name??actor.id},holdings:['Dispatcher']},{id:g.id,type:'Trip',fields}],now:new Date().toISOString()};
  const input={story:action==='dispatch'?'Dispatcher dispatches Trip':'Dispatcher returns Trip',actor:actor.id,object:g.id};
  const result=executeStory(compiled.model,before,input);
  if(!result.committed)fail('No se puede despachar: revisa la hora, el pago, la preparación y que el conductor haya regresado.');
  await tx.query(action==='dispatch'?"UPDATE scheduled_groups SET state='out',departed_at=now() WHERE id=$1":"UPDATE scheduled_groups SET state='returned',returned_at=now() WHERE id=$1",[id]);
  await tx.query('INSERT INTO scheduled_executions(reference,revision,input,before_snapshot,after_snapshot) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[id,compiled.revision,JSON.stringify(input),JSON.stringify(before),JSON.stringify(result.snapshot)]);
  return {id,state:action==='dispatch'?'out':'returned'};
 });
}
