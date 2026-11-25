import {createHash,randomBytes,randomUUID} from 'node:crypto';

export class InviteError extends Error {
  constructor(message,status=400,code='invalid'){super(message);this.status=status;this.code=code;}
}
export const invitationAudience=event=>event.kind==='family'?'amigos-y-familia':event.kind==='influencer'?'influencers':'vip';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(condition,message,status=400,code='invalid')=>{if(condition)throw new InviteError(message,status,code);};
const clean=(value,max=100)=>typeof value==='string'?value.trim().slice(0,max):'';
const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
const serialize=row=>row?{...row,created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()}:null;
export const firstLookEvents=[
  {id:'influencers-2026',kind:'influencer',title:'Invitación para creadores',date:null,slots:[],terms:'Invitación personal para ti y tus acompañantes registrados. No compartas tu enlace.',pricingConfirmed:false},
  {id:'vik-2026',kind:'vik',title:'Encuentro con nuestros primeros clientes',date:'2026-11-22',slots:[{id:'14',label:'2 p. m.',start:'2026-11-22T14:00:00-05:00',end:'2026-11-22T16:00:00-05:00'},{id:'18',label:'6 p. m.',start:'2026-11-22T18:00:00-05:00',end:'2026-11-22T20:00:00-05:00'}],terms:'Apertura secreta, solo para quienes recibieron esta invitación y hasta 3 acompañantes. No compartas tu enlace.',pricingConfirmed:true},
  {id:'familia-2026',kind:'family',title:'Amigos y familia',date:'2026-11-19',slots:[{id:'19',label:'7 p. m.',start:'2026-11-19T19:00:00-05:00',end:'2026-11-19T22:00:00-05:00'}],terms:'Un primer encuentro entre amigos y familia. Tu reserva es para ti y tus acompañantes registrados.',pricingConfirmed:true}
];
export async function migrateFirstLook(db){
  await db.exec(`CREATE TABLE IF NOT EXISTS first_look_events (
    id TEXT PRIMARY KEY,config JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS first_look_invites (
    id UUID PRIMARY KEY,event_id TEXT NOT NULL REFERENCES first_look_events(id),token_hash TEXT NOT NULL UNIQUE,
    guest_name TEXT NOT NULL,max_party INTEGER NOT NULL CHECK(max_party BETWEEN 1 AND 24),revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS first_look_bookings (
    invite_id UUID PRIMARY KEY REFERENCES first_look_invites(id),event_id TEXT NOT NULL REFERENCES first_look_events(id),
    code TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('confirmed','waitlist','cancelled')),
    slot_id TEXT NOT NULL,party_size INTEGER NOT NULL CHECK(party_size BETWEEN 1 AND 24),tables INTEGER NOT NULL CHECK(tables BETWEEN 1 AND 12),
    guest_name TEXT NOT NULL,phone TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS first_look_capacity_idx ON first_look_bookings(event_id,slot_id,status);
  CREATE TABLE IF NOT EXISTS first_look_requests (
    invite_id UUID NOT NULL REFERENCES first_look_invites(id),request_id UUID NOT NULL,fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(invite_id,request_id));`);
  for(const event of firstLookEvents) await db.query(`INSERT INTO first_look_events(id,config) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING`,[event.id,JSON.stringify({...event,tablesPerSlot:12,maxParty:event.kind==='family'?6:4,address:'Calle 3S #43a-40, El Poblado, Medellín',mapUrl:'https://www.google.com/maps/search/?api=1&query=Calle%203S%20%2343a-40%2C%20El%20Poblado%2C%20Medell%C3%ADn',bookingOpen:false})]);
}
export function createFirstLookStore(db,{now=()=>Date.now(),preview=false}={}){
  async function event(tx,id,lock=false){const row=(await tx.query(`SELECT config FROM first_look_events WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];fail(!row,'Evento no disponible.',404,'not_found');return row.config.kind==='vik'?{...row.config,maxParty:Math.min(row.config.maxParty,4)}:row.config;}
  async function invite(tx,token){
    fail(typeof token!=='string'||!/^[A-Za-z0-9_-]{40,60}$/.test(token),'Este pase no está disponible. Abre el enlace personal de tu invitación.',404,'invalid_invite');
    const row=(await tx.query('SELECT * FROM first_look_invites WHERE token_hash=$1',[hash(token)])).rows[0];
    fail(!row||row.revoked||new Date(row.expires_at).getTime()<=now(),'Este pase no está disponible. Abre el enlace personal de tu invitación.',404,'invalid_invite');return row;
  }
  async function booking(tx,id){return serialize((await tx.query('SELECT * FROM first_look_bookings WHERE invite_id=$1',[id])).rows[0]);}
  async function used(tx,eventId,slotId,exceptId=null){return Number((await tx.query(`SELECT coalesce(sum(tables),0)::int AS used FROM first_look_bookings WHERE event_id=$1 AND slot_id=$2 AND status='confirmed' AND ($3::uuid IS NULL OR invite_id<>$3::uuid)`,[eventId,slotId,exceptId])).rows[0].used);}
  async function snapshot(tx,i){
    const e=await event(tx,i.event_id),b=await booking(tx,i.id),max=Math.min(i.max_party,e.maxParty),slots=[];
    for(const s of e.slots){const remaining=Math.max(0,e.tablesPerSlot-await used(tx,e.id,s.id,i.id));slots.push({id:s.id,label:s.label,start:s.start,availableSizes:Array.from({length:max},(_,n)=>n+1).filter(n=>Math.ceil(n/2)<=remaining&&new Date(s.start).getTime()>now())});}
    return {preview,invite:{name:i.guest_name,maxParty:max,audience:invitationAudience(e)},event:{id:e.id,kind:e.kind,title:e.title,date:e.date,address:e.address,mapUrl:e.mapUrl,terms:e.terms,pricingConfirmed:e.pricingConfirmed,bookingOpen:e.bookingOpen,timezone:'America/Bogota',slots},booking:b};
  }
  async function read(token){return db.transaction(async tx=>snapshot(tx,await invite(tx,token)));}
  async function issue({eventId,name,maxParty}){
    name=clean(name,80);fail(!name,'Escribe el nombre de la persona invitada.');
    const e=await event(db,eventId);fail(!e.date||!e.slots.length,'Primero define la fecha y los horarios de este evento.',409,'event_pending');maxParty??=e.maxParty;fail(!integer(maxParty,1,e.maxParty),'Tamaño de grupo inválido.');
    const token=randomBytes(32).toString('base64url'),id=randomUUID(),expires=new Date(Math.max(...e.slots.map(s=>new Date(s.end).getTime()))).toISOString();
    await db.query('INSERT INTO first_look_invites(id,event_id,token_hash,guest_name,max_party,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,eventId,hash(token),name,maxParty,expires]);
    return {id,token,name,eventId,url:'/invitacion/'+invitationAudience(e)+'/'+token};
  }
  async function act(token,body){
    fail(!body||typeof body!=='object','Solicitud inválida.');
    fail(typeof body.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId),'Reintenta desde tu invitación.');
    fail(!['confirm','waitlist','cancel'].includes(body.action),'Acción inválida.');
    const values={action:body.action,version:body.version,slotId:body.slotId,partySize:body.partySize,name:clean(body.name,80),phone:clean(body.phone,40).replace(/[\s().-]/g,''),notes:clean(body.notes,500),accepted:body.accepted===true};
    const fingerprint=hash(JSON.stringify(values));
    return db.transaction(async tx=>{
      const i=await invite(tx,token),e=await event(tx,i.event_id,true);
      const oldRequest=(await tx.query('SELECT fingerprint FROM first_look_requests WHERE invite_id=$1 AND request_id=$2',[i.id,body.requestId])).rows[0];
      if(oldRequest){fail(oldRequest.fingerprint!==fingerprint,'Este intento ya se usó con otros datos. Actualiza tu pase.',409,'request_conflict');return snapshot(tx,i);}
      const b=await booking(tx,i.id);fail(!Number.isInteger(body.version)||body.version!==(b?.version??0),'Tu reserva cambió en otra pantalla. Revisa el estado actual antes de continuar.',409,'stale');
      if(body.action==='cancel'){
        fail(!b||b.status==='cancelled','No hay una reserva activa para cancelar.',409,'no_booking');
        await tx.query(`UPDATE first_look_bookings SET status='cancelled',version=version+1,updated_at=now() WHERE invite_id=$1`,[i.id]);
      }else{
        fail(!e.bookingOpen,'Las reservas todavía no están abiertas.',409,'not_open');
        fail(!preview&&(!e.address||!e.pricingConfirmed),'Estamos afinando los últimos detalles. Vuelve a abrir tu pase pronto.',409,'not_ready');
        const s=e.slots.find(s=>s.id===body.slotId);fail(!s,'Elige un horario válido.');
        fail(new Date(s.start).getTime()<=now(),'Este horario ya pasó.',409,'past');
        fail(!integer(body.partySize,1,Math.min(i.max_party,e.maxParty)),'Revisa cuántas personas vienen.');
        fail(!values.name||values.name.length<2,'Escribe tu nombre.');
        fail(!/^\+?[1-9]\d{6,14}$/.test(values.phone),'Escribe un WhatsApp válido con indicativo de país.');
        fail(!values.accepted,'Confirma las condiciones de tu invitación.');
        const tables=Math.ceil(body.partySize/2),remaining=e.tablesPerSlot-await used(tx,e.id,s.id,i.id),fits=tables<=remaining;
        fail(body.action==='confirm'&&!fits,'Ese horario acaba de llenarse para tu grupo. Elige otro o entra a la lista de espera.',409,'full');
        fail(body.action==='waitlist'&&fits,'Ya hay espacio para tu grupo. Puedes confirmar tu mesa.',409,'space_available');
        // A waitlist request must never silently release an existing confirmed table.
        fail(body.action==='waitlist'&&b?.status==='confirmed','Cancela tu reserva actual antes de pasar a la lista de espera.',409,'has_booking');
        const code=b?.code??'KC-'+randomBytes(5).toString('hex').toUpperCase();
        await tx.query(`INSERT INTO first_look_bookings(invite_id,event_id,code,status,slot_id,party_size,tables,guest_name,phone,notes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(invite_id) DO UPDATE SET status=excluded.status,slot_id=excluded.slot_id,party_size=excluded.party_size,tables=excluded.tables,guest_name=excluded.guest_name,phone=excluded.phone,notes=excluded.notes,version=first_look_bookings.version+1,updated_at=now()`,[i.id,e.id,code,body.action==='confirm'?'confirmed':'waitlist',s.id,body.partySize,tables,values.name,values.phone,values.notes]);
      }
      await tx.query('INSERT INTO first_look_requests(invite_id,request_id,fingerprint) VALUES($1,$2,$3)',[i.id,body.requestId,fingerprint]);
      return snapshot(tx,i);
    });
  }
  async function adminState(){const events=(await db.query('SELECT config FROM first_look_events ORDER BY id DESC')).rows.map(r=>r.config.kind==='vik'?{...r.config,maxParty:Math.min(r.config.maxParty,4)}:r.config);const bookings=(await db.query('SELECT * FROM first_look_bookings ORDER BY created_at')).rows.map(serialize);return {preview,events,bookings,invites:(await db.query('SELECT id,event_id,guest_name,max_party,revoked,created_at FROM first_look_invites ORDER BY created_at DESC')).rows,counts:events.map(e=>({eventId:e.id,slots:e.slots.map(s=>({id:s.id,label:s.label,tables:bookings.filter(b=>b.event_id===e.id&&b.slot_id===s.id&&b.status==='confirmed').reduce((n,b)=>n+b.tables,0),guests:bookings.filter(b=>b.event_id===e.id&&b.slot_id===s.id&&b.status==='confirmed').reduce((n,b)=>n+b.party_size,0)}))}))};}
  async function configure(id,input){return db.transaction(async tx=>{
    const e=await event(tx,id,true),next={...e,address:clean(input.address,240),terms:clean(input.terms,500),mapUrl:clean(input.mapUrl,500),tablesPerSlot:input.tablesPerSlot,maxParty:input.maxParty,pricingConfirmed:input.pricingConfirmed===true,bookingOpen:input.bookingOpen===true};
    fail(!integer(next.tablesPerSlot,1,12)||!integer(next.maxParty,1,e.kind==='family'?24:4),'Revisa el número de mesas o el límite de personas.');
    fail(next.mapUrl&&!/^https:\/\/(maps\.app\.goo\.gl|(?:www\.)?google\.(?:com|com\.co))\//.test(next.mapUrl),'Usa un enlace HTTPS de Google Maps.');
    fail(next.bookingOpen&&(!next.date||!next.slots.length),'Define la fecha y los horarios antes de abrir reservas.');
    fail(next.bookingOpen&&!preview&&(!next.address||!next.terms||!next.pricingConfirmed),'Confirma dirección y condiciones antes de abrir reservas.');
    for(const s of e.slots)fail(await used(tx,id,s.id)>next.tablesPerSlot,'Ya hay más mesas reservadas que ese límite.',409);
    await tx.query('UPDATE first_look_events SET config=$2::jsonb WHERE id=$1',[id,JSON.stringify(next)]);return next;
  });}
  return {read,issue,act,adminState,configure};
}
