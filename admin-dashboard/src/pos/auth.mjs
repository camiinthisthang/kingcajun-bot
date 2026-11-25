import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
const digest=s=>createHash('sha256').update(s).digest('hex');
export async function migrateStaff(db){await db.exec(`
  CREATE TABLE IF NOT EXISTS pos_staff(id UUID PRIMARY KEY,name TEXT NOT NULL,login TEXT NOT NULL UNIQUE,roles JSONB NOT NULL,password_hash TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE);
  CREATE TABLE IF NOT EXISTS pos_sessions(token_hash TEXT PRIMARY KEY,staff_id UUID NOT NULL REFERENCES pos_staff(id),expires_at TIMESTAMPTZ NOT NULL);
  CREATE TABLE IF NOT EXISTS pos_login_attempts(login TEXT PRIMARY KEY,attempts INTEGER NOT NULL,blocked_until TIMESTAMPTZ NOT NULL);
`);}
export async function provisionStaff(db,{name,login,password,roles}){
  if(typeof name!=='string'||!name.trim()||name.length>60||typeof login!=='string'||!/^[-a-z0-9_]{3,40}$/.test(login)||typeof password!=='string'||password.length<10||password.length>128||!Array.isArray(roles)||!roles.length||roles.some(r=>!['Waiter','Cook','Manager'].includes(r)))throw Object.assign(Error('Revisa el nombre, usuario, contraseña (mínimo 10 caracteres) y permisos.'),{status:400});
  const salt=randomBytes(16).toString('hex'),hash=scryptSync(password,salt,32).toString('hex');
  const row=(await db.query('INSERT INTO pos_staff(id,name,login,roles,password_hash) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id,name,login,roles',[randomUUID(),name.trim(),login,JSON.stringify(roles),`${salt}:${hash}`])).rows[0];return row;
}
export function staffAuth(db,{validAdmin,adminUser,production,kitchenOnly}){
  const cookie=req=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('kc_pos='))?.slice(7);
  const identity=async req=>{
    const token=cookie(req);
    if(token){const row=(await db.query('SELECT s.id,s.name,s.roles FROM pos_sessions x JOIN pos_staff s ON s.id=x.staff_id WHERE x.token_hash=$1 AND x.expires_at>now() AND s.active=TRUE',[digest(token)])).rows[0];if(row)return row;}
    if(validAdmin(req))return {id:`admin:${adminUser}`,name:adminUser,roles:kitchenOnly?['Cook']:['Waiter','Cook','Manager'],owner:!kitchenOnly};
    return null;
  };
  const requireStaff=async(req,res,next)=>{try{req.posActor=await identity(req);if(req.posActor)return next();if(req.path.startsWith('/api/'))return res.status(401).json({error:'Inicia sesión con tu usuario del equipo.'});return res.redirect('/mesas/login');}catch{return res.status(503).json({error:'No se pudo verificar tu sesión.'});}};
  const login=async(req,res)=>{
    const login=String(req.body?.login||'').toLowerCase().slice(0,40),password=String(req.body?.password||'').slice(0,129);
    const result=await db.transaction(async tx=>{
      await tx.query("INSERT INTO pos_login_attempts VALUES($1,0,now()) ON CONFLICT DO NOTHING",[login]);
      const attempt=(await tx.query('SELECT * FROM pos_login_attempts WHERE login=$1 FOR UPDATE',[login])).rows[0];
      if(new Date(attempt.blocked_until)>new Date())return {status:429,error:'Espera un minuto antes de volver a intentar.'};
      const staff=(await tx.query('SELECT * FROM pos_staff WHERE login=$1 AND active=TRUE',[login])).rows[0];
      const [salt,hash]=(staff?.password_hash||'unknown:'+Buffer.alloc(32).toString('hex')).split(':');
      const valid=timingSafeEqual(scryptSync(password,salt,32),Buffer.from(hash,'hex'))&&staff;
      if(!valid){await tx.query("UPDATE pos_login_attempts SET attempts=attempts+1,blocked_until=CASE WHEN attempts>=4 THEN now()+interval '1 minute' ELSE now() END WHERE login=$1",[login]);return {status:401,error:'Usuario o contraseña incorrectos.'};}
      await tx.query('DELETE FROM pos_login_attempts WHERE login=$1',[login]);
      const token=randomBytes(32).toString('base64url');
      await tx.query("INSERT INTO pos_sessions VALUES($1,$2,now()+interval '8 hours')",[digest(token),staff.id]);
      return {token,actor:{id:staff.id,name:staff.name,roles:staff.roles}};
    });
    if(result.error)return res.status(result.status).json({error:result.error});
    res.append('Set-Cookie',`kc_pos=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production?'; Secure':''}`);res.json(result.actor);
  };
  return {requireStaff,login,identity,logout:async(req,res)=>{await db.query('DELETE FROM pos_sessions WHERE token_hash=$1',[digest(cookie(req)||'')]);res.append('Set-Cookie','kc_pos=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true});}};
}
