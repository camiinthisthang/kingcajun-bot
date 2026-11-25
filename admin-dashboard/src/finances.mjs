import {KitchenError} from './kitchen-domain.mjs';
import {currentWeek,validDate,bogotaDate} from '../public/reporting-period.js';
export const financeCategories={ingredients:'Ingredientes',packaging:'Empaques',delivery:'Domiciliarios',labor:'Personal',rent:'Arriendo',utilities:'Servicios',equipment:'Equipos',refund:'Devoluciones',other_expense:'Otros gastos',capital:'Aporte de capital',other_income:'Otros ingresos'};
const incomeCategories=new Set(['capital','other_income']);
export async function migrateFinances(db){await db.exec(`CREATE TABLE IF NOT EXISTS finance_entries (
 id UUID PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('in','out')), category TEXT NOT NULL,
 amount_cop INTEGER NOT NULL CHECK(amount_cop>0), occurred_on DATE NOT NULL, description TEXT NOT NULL,
 reference TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 voided BOOLEAN NOT NULL DEFAULT false, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS finance_entries_date_idx ON finance_entries(occurred_on);`);}
export function financePeriod(query,now=new Date()){
 if(query.period==='all')return {from:null,to:null};
 const week=currentWeek(now),from=query.from||week.from,to=query.to||week.to;
 if(!validDate(from)||!validDate(to)||from>to)throw new KitchenError('Revisa el rango de fechas.');
 return {from,to};
}
export async function addFinanceEntry(db,input,actor){
 const {id,category,amountCop,date}=input;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id||'')||!Object.hasOwn(financeCategories,category)||!Number.isSafeInteger(amountCop)||amountCop<=0||amountCop>2000000000||!validDate(date)||date>bogotaDate())throw new KitchenError('Revisa la fecha, categoría y monto en pesos enteros. Solo registra movimientos ya realizados.');
 const description=typeof input.description==='string'?input.description.trim():'';
 const reference=typeof input.reference==='string'?input.reference.trim():'';
 if(!description||description.length>500||reference.length>150)throw new KitchenError('Escribe un concepto de hasta 500 caracteres y una referencia de hasta 150.');
 const direction=incomeCategories.has(category)?'in':'out';
 const values=[id,direction,category,amountCop,date,description,reference,actor];
 await db.query('INSERT INTO finance_entries(id,direction,category,amount_cop,occurred_on,description,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',values);
 const row=(await db.query('SELECT *,occurred_on::text AS date FROM finance_entries WHERE id=$1',[id])).rows[0];
 if(row.category!==category||row.amount_cop!==amountCop||row.date!==date||row.description!==description||row.reference!==reference)throw new KitchenError('Este guardado ya existe con otros datos. Abre un movimiento nuevo.',409);
 return {id:row.id,saved:true};
}
export async function voidFinanceEntry(db,id,voided,actor){
 if(typeof voided!=='boolean'||! /^[0-9a-f-]{36}$/i.test(id))throw new KitchenError('Movimiento inválido.');
 const row=await db.query('UPDATE finance_entries SET voided=$2,updated_by=$3,updated_at=now() WHERE id=$1 RETURNING id',[id,voided,actor]);
 if(!row.rowCount)throw new KitchenError('Movimiento no encontrado.',404);
 return {id,voided};
}
export async function financeSnapshot(db,query={},now=new Date()){
 const period=financePeriod(query,now);
 const records=(await db.query(`SELECT * FROM (
 SELECT 'payment:'||p.id::text AS id,'payment' AS source,'in' AS direction,'orders' AS category,p.amount_cop,
 (COALESCE(p.confirmed_at,p.created_at) AT TIME ZONE 'America/Bogota')::date::text AS date,
 COALESCE(c.display_name,'Cliente WhatsApp') AS description,o.public_id AS reference,false AS voided,
 p.confirmed_at IS NULL AS date_estimated,o.status AS order_status
 FROM payments p JOIN orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id WHERE p.status='confirmed'
 UNION ALL SELECT 'marketing:'||id::text,'marketing','out','marketing',amount_cop,(spent_at AT TIME ZONE 'America/Bogota')::date::text,campaign_name,COALESCE(notes,''),false,false,NULL FROM marketing_spend
 UNION ALL SELECT id::text,'manual',direction,category,amount_cop,occurred_on::text,description,reference,voided,false,NULL FROM finance_entries
 ) entries WHERE ($1::date IS NULL OR date::date>=$1::date) AND ($2::date IS NULL OR date::date<=$2::date) ORDER BY date DESC,id`,[period.from,period.to])).rows;
 const totals={inCop:0,outCop:0,orderPaymentsCop:0,otherIncomeCop:0,netCop:0,voidedCount:0,estimatedDateCount:0};
 const categories=new Map(),days=new Map();
 for(const row of records){if(row.voided){totals.voidedCount++;continue;}const amount=Number(row.amount_cop);totals[row.direction==='in'?'inCop':'outCop']+=amount;if(row.source==='payment')totals.orderPaymentsCop+=amount;else if(row.direction==='in')totals.otherIncomeCop+=amount;if(row.date_estimated)totals.estimatedDateCount++;
  categories.set(row.category,(categories.get(row.category)||0)+amount);
  const day=days.get(row.date)||{date:row.date,inCop:0,outCop:0};day[row.direction==='in'?'inCop':'outCop']+=amount;days.set(row.date,day);
 }
 totals.netCop=totals.inCop-totals.outCop;
 const refunds=(await db.query("SELECT o.public_id,COALESCE((SELECT sum(amount_cop) FROM payments WHERE order_id=o.id AND status='confirmed'),0)::int AS received_cop FROM orders o WHERE o.refund_status='pending' ORDER BY o.created_at DESC")).rows;
 return {period,totals,categories:[...categories].map(([key,amountCop])=>({key,label:financeCategories[key]||({orders:'Cobros de pedidos',marketing:'Marketing'})[key],amountCop})),daily:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),records,refunds};
}
