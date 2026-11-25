import {KitchenError} from './kitchen-domain.mjs';
const amount=v=>Number.isSafeInteger(v)&&v>=0&&v<=2000000000;
export function settlementBasis(group){return group.stops.map(s=>({reference:s.reference,name:s.name,balance:s.balance}));}
export function settlementMath(stops,fee,received=null,paid=0){
 if(!amount(fee)||received!==null&&!amount(received)||!amount(paid))throw new KitchenError('Usa valores enteros en pesos, sin puntos.');
 const toCollect=stops.reduce((n,s)=>n+s.balance,0),deliveryPay=stops.length*fee,expected=toCollect-deliveryPay;
 const actual=received===null?null:received-paid;
 return {toCollect,deliveries:stops.length,deliveryPay,expected,actual,difference:actual===null?null:actual-expected};
}
export async function saveRouteSettlement(db,date,driver,input,readRoutes){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(driver)||driver<1||driver>12)throw new KitchenError('Fecha o conductor inválido.');
 if(typeof input.driverName!=='string'||input.driverName.length>100)throw new KitchenError('Nombre de conductor inválido.');
 settlementMath([],input.fee,input.received,input.paid);
 return db.transaction(async tx=>{
 const row=(await tx.query('SELECT id,document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[date])).rows[0];if(!row)throw new KitchenError('Jornada no encontrada.',404);
 const routes=await readRoutes(tx,date),group=routes.groups.find(g=>g.driver===driver);if(!group)throw new KitchenError('Ruta no encontrada.',404);
 const saved=row.document.routeSettlements?.[driver];
 if((saved?.revision??0)!==input.revision)throw new KitchenError('La liquidación cambió en otra ventana. Actualiza antes de guardar.',409);
 const stops=saved?.stops??settlementBasis(group);
 if(!saved&&JSON.stringify(stops)!==JSON.stringify(input.basis))throw new KitchenError('Los saldos o la ruta cambiaron. Actualiza y revisa antes de guardar.',409);
 const result={driver,driverName:input.driverName.trim(),stops,fee:input.fee,received:input.received,paid:input.paid,...settlementMath(stops,input.fee,input.received,input.paid),revision:(saved?.revision??0)+1,createdAt:saved?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()};
 const doc=row.document;doc.routeSettlements??={};doc.routeSettlementAudit??=[];if(saved)doc.routeSettlementAudit.push(saved);doc.routeSettlements[driver]=result;
 await tx.query('UPDATE kitchen_runs SET document=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(doc)]);
 return result;
 });
}
