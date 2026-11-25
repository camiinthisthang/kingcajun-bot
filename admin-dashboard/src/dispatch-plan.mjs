import {routeCuts} from '../public/route-trips.js';
import {KitchenError} from './kitchen-domain.mjs';
import {packingRoutePlan} from './delivery-routes.mjs';
export async function saveDispatchPlan(db,date,input){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new KitchenError('Fecha inválida.');
 return db.transaction(async tx=>{
  const row=(await tx.query('SELECT id,document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[date])).rows[0];
  if(!row)throw new KitchenError('Jornada no encontrada.',404);
  if(input.batchId){
   const doc=row.document;
   if(JSON.stringify(doc.packingBatches)!==JSON.stringify(input.expectedBatches))throw new KitchenError('Las tandas cambiaron. Actualiza antes de guardar.',409);
   const batch=doc.packingBatches?.find(b=>b.id===input.batchId),wanted=input.references;
   if(!batch||!Array.isArray(wanted)||wanted.length!==batch.orders.length||new Set(wanted).size!==wanted.length||wanted.some(r=>!batch.orders.includes(r)))throw new KitchenError('Los pedidos de la tanda cambiaron.',409);
   batch.orders=[...wanted];
   const groups=structuredClone(await packingRoutePlan(date,doc.dispatchOverride));
   const group=groups.find(g=>wanted.every(ref=>g.orders.includes(ref)));
   if(group){const positions=group.orders.map((ref,i)=>wanted.includes(ref)?i:-1).filter(i=>i>=0);positions.forEach((pos,i)=>group.orders[pos]=wanted[i]);doc.dispatchOverride={...doc.dispatchOverride,groups,updatedAt:new Date().toISOString()};doc.packingRoutes=groups;}
   doc.packingBatchesUpdatedAt=new Date().toISOString();
   await tx.query('UPDATE kitchen_runs SET document=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(doc)]);
   return doc.packingBatches;
  }
  const doc=row.document,groups=structuredClone(await packingRoutePlan(date,doc.dispatchOverride));
  if(JSON.stringify(groups)!==JSON.stringify(input.expectedGroups))throw new KitchenError('Las rutas cambiaron. Actualiza antes de guardar.',409);
  if(input.mode){
   if(!['whole','split','saved'].includes(input.mode))throw new KitchenError('Plan inválido.');
   for(const g of groups){if(Array.isArray(g.selectedSplitAfters)){g.agreedSplitAfters??=[...g.selectedSplitAfters];g.selectedSplitAfters=input.mode==='whole'?[]:input.mode==='split'?(g.splitAfter?[g.splitAfter]:[]):g.agreedSplitAfters;}g.agreedSplitAfter??=g.selectedSplitAfter??null;g.selectedSplitAfter=input.mode==='whole'?null:input.mode==='split'?(g.splitAfter??null):g.agreedSplitAfter;g.note='Seguir el orden y los viajes guardados en Empacar.';delete g.splitTiming;}
  }else{
   const g=groups.find(g=>g.driver===input.driver);if(!g||!Number.isInteger(input.trip)||input.trip<1||input.trip>routeCuts(g).length+1)throw new KitchenError('Viaje inválido.');
   const boundaries=[0,...routeCuts(g),g.orders.length],start=boundaries[input.trip-1],end=boundaries[input.trip];
   const refs=g.orders.slice(start,end),wanted=input.references;
   if(!Array.isArray(wanted)||wanted.length!==refs.length||new Set(wanted).size!==refs.length||wanted.some(r=>!refs.includes(r)))throw new KitchenError('Los pedidos del viaje cambiaron.',409);
   g.orders.splice(start,refs.length,...wanted);g.note='Seguir este orden de entrega, actualizado desde Empacar.';
  }
  const revision=new Date().toISOString();for(const g of groups)g.dispatchRevision=revision;
  doc.dispatchOverride={...doc.dispatchOverride,riderCount:doc.dispatchOverride?.riderCount||groups.length,groups,mode:input.mode||doc.dispatchOverride?.mode||'saved',updatedAt:revision};
  doc.packingRoutes=groups;
  await tx.query('UPDATE kitchen_runs SET document=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(doc)]);
  return doc.dispatchOverride;
 });
}
