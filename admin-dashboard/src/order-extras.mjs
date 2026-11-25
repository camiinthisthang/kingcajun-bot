import {reconcile} from './kitchen-sync.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {requireValue,quoteOrder,validateCatalog} from './kitchen-domain.mjs';

export const extraSlugs=['kit_opcional','drink_6'];
const money=n=>'$'+Number(n).toLocaleString('es-CO');
export async function migrateOrderExtras(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS order_extras(
  id UUID PRIMARY KEY,reference TEXT NOT NULL UNIQUE,order_id UUID NOT NULL REFERENCES orders(id),
  request_event_id TEXT NOT NULL UNIQUE,lines JSONB NOT NULL,total_cop INTEGER NOT NULL CHECK(total_cop>0),
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancelled','expired')),expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,confirmed_at TIMESTAMPTZ,confirmed_by TEXT,payment_id UUID REFERENCES payments(id));
 CREATE UNIQUE INDEX IF NOT EXISTS order_extras_one_pending ON order_extras(order_id) WHERE status='pending';
 CREATE TABLE IF NOT EXISTS menu_stock(slug TEXT PRIMARY KEY,received_quantity INTEGER NOT NULL CHECK(received_quantity>=0),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),note TEXT NOT NULL DEFAULT '');
 ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS extras_offered BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS extras_declined BOOLEAN NOT NULL DEFAULT FALSE;`);
}
export async function stockRemaining(db,slug,now=new Date(),excludeAdditionId=null){
 const stock=(await db.query('SELECT received_quantity FROM menu_stock WHERE slug=$1',[slug])).rows[0];
 if(!stock)return null;
 const row=(await db.query(`SELECT
 COALESCE((SELECT SUM(l.quantity) FROM order_line_items l JOIN menu_items m ON m.id=l.menu_item_id JOIN orders o ON o.id=l.order_id WHERE m.slug=$1 AND (o.status IN ('confirmed','fulfilled','payment_review') OR o.status='awaiting_payment' AND o.payment_expires_at>$2)),0)+
 COALESCE((SELECT SUM((line->>'quantity')::numeric) FROM order_extras e JOIN orders o ON o.id=e.order_id CROSS JOIN LATERAL jsonb_array_elements(e.lines) line WHERE e.status='pending' AND e.expires_at>$2 AND o.status='confirmed' AND line->>'slug'=$1 AND ($3::uuid IS NULL OR e.id<>$3)),0) AS used`,[slug,now.toISOString(),excludeAdditionId])).rows[0];
 return Math.max(0,stock.received_quantity-Number(row.used));
}
export async function checkStock(tx,lines,now=new Date(),excludeAdditionId=null){
 const totals=new Map();for(const l of lines)totals.set(l.slug,(totals.get(l.slug)??0)+Number(l.quantity));
 for(const [slug,quantity] of [...totals].sort(([a],[b])=>a.localeCompare(b))){
  await tx.query('SELECT slug FROM menu_stock WHERE slug=$1 FOR UPDATE',[slug]);
  const left=await stockRemaining(tx,slug,now,excludeAdditionId);
  requireValue(left===null||quantity<=left,`Solo quedan ${left} unidades disponibles de ${slug==='drink_6'?'Coca-Cola de 250 ml':slug}. Ajusta la cantidad.`,409);
 }
}
export async function extrasCatalog(db,orderId=null,now=new Date()){
 const rows=(await db.query('SELECT id::text,slug,name,price_cop,metadata_json FROM menu_items WHERE active=TRUE AND slug=ANY($1::text[]) ORDER BY slug',[extraSlugs])).rows;
 const owned=orderId?(await db.query('SELECT DISTINCT m.slug FROM order_line_items l JOIN menu_items m ON m.id=l.menu_item_id WHERE l.order_id=$1',[orderId])).rows.map(r=>r.slug):[];
 const eligible=[];for(const item of rows)if(!owned.includes(item.slug)&&(await stockRemaining(db,item.slug,now))!==0)eligible.push(item);
 return eligible;
}
export function extrasDescription(items){return items.map(i=>i.slug==='kit_opcional'?`Kit de guantes plásticos, babero y mantel: ${money(i.price_cop)} por persona`:`Coca-Cola de 250 ml: ${money(i.price_cop)} c/u`).join('; ');}
export function extrasPrompt(items,reference=''){
 const nouns=items.map(i=>i.slug==='kit_opcional'?'kits':'cocas');
 const example=nouns.map(noun=>'2 '+noun).join(' y ');
 return `¿Quieres agregar extras?\n${extrasDescription(items).split('; ').map(s=>'• '+s).join('\n')}\n${reference?`Responde EXTRAS ${reference} y las cantidades (por ejemplo, «${example}»). Los extras se pagan completos por transferencia antes de agregarlos, sin otro domicilio.`:`Dime las cantidades (por ejemplo, «${example}»), o responde NO para continuar.`}`;
}
export async function reminderExtras(db,orderId,now=new Date()){
 const o=(await db.query('SELECT o.*,w.starts_at FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1',[orderId])).rows[0];
 if(!o||o.status!=='confirmed'||o.extras_declined||+new Date(o.starts_at)-3600000<=+now)return [];
 if((await db.query("SELECT id FROM order_extras WHERE order_id=$1 AND status='pending' AND expires_at>$2",[orderId,now.toISOString()])).rowCount)return [];
 const catalog=await extrasCatalog(db,orderId,now);if(!catalog.length)return [];
 const run=(await db.query("SELECT document->>'phase' AS phase FROM kitchen_runs WHERE delivery_date=($1::timestamptz AT TIME ZONE 'America/Bogota')::date",[o.starts_at])).rows[0];
 return run?.phase==='complete'?[]:catalog;
}

// Only count/pack items are accepted after the kitchen's food cutoff. Existing
// food snapshots and their paid prices are never reconstructed from today's menu.
export async function confirmOrderExtras(tx,orderId,event,now=new Date()){
 const date=(await tx.query("SELECT (w.starts_at AT TIME ZONE 'America/Bogota')::date::text AS date FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id WHERE o.id=$1",[orderId])).rows[0]?.date;
 const run=(await tx.query('SELECT id,document FROM kitchen_runs WHERE delivery_date=$1 FOR UPDATE',[date])).rows[0];
 const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
 const pending=(await tx.query("SELECT * FROM order_extras WHERE order_id=$1 AND status='pending' FOR UPDATE",[orderId])).rows[0];
 if(!pending)return null;
 requireValue(order.status==='confirmed','Primero verifica el pedido original antes de confirmar extras.',409);
 requireValue(+new Date(pending.created_at)<=+new Date(event.sentAt)+999&&new Date(pending.expires_at)>now,'La solicitud de extras es posterior al comando o su plazo terminó. Revisa el pago.',409);
 requireValue(!run||run.document.phase!=='complete','La jornada ya terminó. Revisa los extras y el pago antes de despachar.',409);
 const lines=pending.lines;
 requireValue(lines.length&&lines.every(l=>extraSlugs.includes(l.slug)&&Number.isSafeInteger(l.quantity)&&l.quantity>0&&l.kitchenSnapshot&&!l.kitchenSnapshot.product.requiresHeat&&l.kitchenSnapshot.ingredients.every(i=>i.unit==='piece')),'Extras fuera del flujo de empaque permitido.',409);
 await checkStock(tx,lines,now,pending.id);
 if(run&&!run.document.orders.some(o=>o.sourceOrderId===orderId)&&run.document.phase==='planning')await reconcile(tx,run.document,now);
 const paymentId=randomUUID(),iso=now.toISOString();
 await tx.query(`INSERT INTO payments(id,order_id,provider,provider_payment_id,reference,amount_cop,status,raw_payload_json,confirmed_at,created_at,updated_at) VALUES($1,$2,'manual_transfer',$3,$4,$5,'confirmed',$6::jsonb,$7,$7,$7)`,[paymentId,orderId,'WA-EXTRAS:'+pending.id,pending.reference,pending.total_cop,JSON.stringify({source:'staff_extras_verification',staffEventId:event.eventId,reviewedBy:'WhatsApp Business · CONFIRMADO'}),iso]);
 for(const l of lines)await tx.query(`INSERT INTO order_line_items(id,order_id,menu_item_id,item_name_snapshot,quantity,unit_price_cop,line_total_cop,customization_json,kitchen_snapshot_json,costing_snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8::jsonb,$9::jsonb)`,[randomUUID(),orderId,l.menuItemId,l.name,l.quantity,l.priceCop,l.totalCop,JSON.stringify(l.kitchenSnapshot),JSON.stringify(l.costingSnapshot)]);
 await tx.query('UPDATE orders SET subtotal_cop=subtotal_cop+$2,total_cop=total_cop+$2,updated_at=$3 WHERE id=$1',[orderId,pending.total_cop,iso]);
 await tx.query("UPDATE order_extras SET status='confirmed',confirmed_at=$2,confirmed_by=$3,payment_id=$4 WHERE id=$1",[pending.id,iso,event.eventId,paymentId]);
 if(run){
  const saved=run.document.orders.find(o=>o.sourceOrderId===orderId);
  requireValue(saved&&!saved.cancelled,'El pedido original no está sincronizado en cocina; revisa antes de agregar extras.',409);
  // Put additions in a new packing bag, preserving cooked food/portion checks.
  const bag=1+Math.max(0,...saved.lines.map(l=>l.bag));
  const products=lines.map((l,i)=>({...l.kitchenSnapshot.product,id:`extra-${pending.id}-${i}`}));
  const ingredients=[];for(const l of lines)for(const ingredient of l.kitchenSnapshot.ingredients){
   const existing=run.document.ingredients.find(i=>i.id===ingredient.id);
   requireValue(!existing||isDeepStrictEqual(existing,validateCatalog({products:[],ingredients:[ingredient]}).ingredients[0]),'La definición del extra cambió. Revisa el empaque.',409);
   if(!ingredients.some(i=>i.id===ingredient.id))ingredients.push(ingredient);
  }
  const catalog=validateCatalog({products,ingredients});
  const added=quoteOrder(catalog,{reference:order.public_id,customer:saved.customer,lines:lines.map((l,i)=>({productId:products[i].id,quantity:l.kitchenSnapshot.quantity,bag,heat:null})),agreedTotalCop:pending.total_cop});
  saved.lines.push(...added.lines);saved.totalCop+=pending.total_cop;saved.agreedTotalCop+=pending.total_cop;
  for(const i of catalog.ingredients)if(!run.document.ingredients.some(x=>x.id===i.id))run.document.ingredients.push(i);
  run.document.audit.push({type:'paidExtras',orderId,reference:pending.reference,amountCop:pending.total_cop,bag,at:iso});
  await tx.query('UPDATE kitchen_runs SET document=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1',[run.id,JSON.stringify(run.document),iso]);
 }
 return {reference:pending.reference,amountCop:pending.total_cop};
}
