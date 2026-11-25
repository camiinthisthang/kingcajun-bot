import {prepareScheduledCheckout,finishScheduledCheckout} from '../../admin-dashboard/src/scheduled-orders.mjs';
import {attachDelivery,posWindows,requestDeliveryCancellation} from '../../admin-dashboard/src/pos/delivery.mjs';
import {exactWindowCapacity} from '../../admin-dashboard/src/exact-window-capacity.mjs';
import {checkStock} from '../../admin-dashboard/src/order-extras.mjs';
import {orderingPauseReply} from './ordering-pause.js';
import {PREPAID_DELIVERIES_PER_DAY,prepaidUsedSql} from '../../admin-dashboard/src/prepaid-capacity.mjs';
import {attachCrabPortions,crabKind} from './crab-portions.js';
import {wholePieceNote} from '../../admin-dashboard/src/crab-labels.mjs';
import {coverageSnapshot,locationFromAddress,type DeliveryCoverage,type DeliveryLocation,type DeliveryPreference,specialDeliveryZone} from './delivery-coverage.js';
import {bookingCapacitySql, deliveryCapacitySql, usesDeliveryCapacity, lockDeliveryCapacity, deliveryCapacityUsed} from '../../admin-dashboard/src/booking-capacity.mjs';
import {paymentPolicy} from '../business-policy.js';
import {lineCharge} from '../../admin-dashboard/src/costing/pricing.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { windowLabel } from '../lib/format.js';
import { requireBotAccess } from '../lib/bot-access.js';
import { snapshotKitchenLine } from './kitchen-snapshot.js';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { CartLine } from '../types.js';
import { ManualTransferPaymentProvider, type PaymentProvider, type PaymentInstructions } from '../providers/payment.js';

export type MenuRow = {
  id: string; sku: string; name: string; description: string; category: 'plate' | 'addon' | 'drink';
  price_cop: number; metadata_json: string; menu_version?: number; slug?: string;
};

type CreatedOrder={orderId:string;publicId:string;reference:string;total:number;deposit:number;fullPayment:boolean;prepaidDelivery:boolean;paymentAmount:number;expiresAt:string};

export class OrderService {
  private menuRows: MenuRow[] = [];
  private currentVersion = 0;
  private loadedAt = 0;
  menuVersion() { return this.currentVersion; }

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly payments: PaymentProvider) {}

  async loadMenu() {
    // Check the version on every message. Reuse the payload only while unchanged.
    await this.db.transaction(async tx => {
      const state=(await tx.query<{version:number;derived?:{deliveryEquipmentCost:number;deliveryCostMissing:boolean}}>('SELECT version,derived FROM costing_state WHERE id=1 FOR SHARE')).rows[0];
      const version=state?.version??0;
      if(version>0 && version===this.currentVersion && Date.now()-this.loadedAt<5000)return;
      this.menuRows=(await tx.query<MenuRow>(`SELECT id::text,sku,slug,name,description,category,price_cop,metadata_json::text,menu_version FROM menu_items WHERE active=TRUE ORDER BY sort_order,name`)).rows;
      if(version>0){
        const settings=Object.fromEntries((await tx.query<{key:string;value:string}>('SELECT key,value FROM costing_settings')).rows.map(r=>[r.key,Number(r.value)]));
        const ranges=(await tx.query<{specification:unknown}>('SELECT specification FROM costing_ranges')).rows.map(r=>r.specification);
        attachCrabPortions(this.menuRows,settings,ranges);
      }
      this.currentVersion=version;this.loadedAt=Date.now();
    });
  }

  menu() { return this.menuRows; }

  async quote(cart: CartLine[], referralCode?: string, preference?: string) {
    const subtotal = cart.reduce((sum,line)=>sum+lineCharge(this.menuRows.find(i=>i.id===line.menuItemId||i.slug===line.menuItemId)!.price_cop,line.quantity),0);
    const fee = ['pickup','own_courier'].includes(preference??'') ? 0 : Number((await this.db.query<{delivery_fee_cop:number}>('SELECT delivery_fee_cop FROM checkout_settings WHERE id=1')).rows[0]?.delivery_fee_cop ?? 0);
    const referral = referralCode ? (await this.db.query<{free_delivery:boolean}>(`SELECT free_delivery FROM referral_codes WHERE lower(code)=lower($1) AND active=TRUE AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now())`,[referralCode])).rows[0] : undefined;
    const discount=referral?.free_delivery ? fee : 0;
    return {subtotal,fee,discount,total:subtotal+fee-discount};
  }

  async coverage(location:DeliveryLocation,preference?:DeliveryPreference,windowId?:string) {
    const base=coverageSnapshot(location,preference);
    if(!base.destinationZone)return base;
    const windows=await this.availableWindows('delivery',true,true,base.destinationZone);
    if(!windows.some(w=>!windowId||w.id===windowId))return base;
    return {...base,status:'inside' as const,needsReview:false,capacityZone:base.destinationZone,label:'Itagüí · ruta especial con pago completo anticipado'};
  }

  async availableWindows(type: 'delivery' | 'pickup' = 'delivery', includeFull = false, allowPrepaid = false, zone:string|null=null):Promise<any[]> {
    if (this.cfg.BOT_MODE !== 'ordering' || this.cfg.NEW_ORDERS_PAUSED) return [];
    if(this.cfg.POS_RUNTIME_ENABLED)return posWindows(this.db,includeFull);
    const now = new Date().toISOString();
    await this.db.query(`UPDATE orders SET status = 'expired', updated_at = $1 WHERE status = 'awaiting_payment' AND payment_expires_at <= $1`, [now]);
    if(zone&&type==='delivery'){
      const rows=(await this.db.query<any>(`SELECT w.*,a.zone AS delivery_zone,
        a.capacity-COUNT(o.id)::int AS remaining,a.capacity-COUNT(o.id)::int AS daily_remaining,
        0 AS prepaid_remaining,TRUE AS prepayment_required,TRUE AS date_full_payment_required,FALSE AS pickup_available
        FROM delivery_windows w JOIN delivery_zone_allowances a ON a.delivery_window_id=w.id AND a.zone=$2
        LEFT JOIN orders o ON o.delivery_window_id=w.id AND ${deliveryCapacitySql('o','a.zone')}
          AND (o.status IN ('confirmed','fulfilled','payment_review') OR (o.status='awaiting_payment' AND o.payment_expires_at>$1))
        WHERE w.status='open' AND w.fulfillment_type='delivery' AND w.starts_at>$1 AND w.order_cutoff_at>$1
          AND (w.order_opens_at IS NULL OR w.order_opens_at<=$1)
          AND date_trunc('week',w.starts_at AT TIME ZONE 'America/Bogota')=(SELECT min(date_trunc('week',starts_at AT TIME ZONE 'America/Bogota')) FROM delivery_windows WHERE ends_at>$1)
        GROUP BY w.id,a.zone,a.capacity ORDER BY w.starts_at`,[now,zone])).rows;
      return includeFull?rows:rows.filter(w=>w.remaining>0&&new Date(w.starts_at).getTime()-12*3600000>Date.now());
    }
    const dateSQL="(w.starts_at AT TIME ZONE 'America/Bogota')::date";
    const dayBase=`COALESCE((SELECT capacity FROM delivery_date_limits WHERE delivery_date=${dateSQL}), (SELECT SUM(dw.capacity) FROM delivery_windows dw WHERE (dw.starts_at AT TIME ZONE 'America/Bogota')::date=${dateSQL}))`;
    const dayRemaining=`${bookingCapacitySql(dayBase)} - (SELECT COUNT(*)::int FROM orders od JOIN delivery_windows wd ON wd.id=od.delivery_window_id WHERE (wd.starts_at AT TIME ZONE 'America/Bogota')::date=${dateSQL} AND ${deliveryCapacitySql('od')} AND (od.status IN ('confirmed','fulfilled','payment_review') OR (od.status='awaiting_payment' AND od.payment_expires_at>$1)))`;
    const remaining=`LEAST(${bookingCapacitySql('w.capacity')} - COUNT(o.id)::int, ${dayRemaining})`;
    const prepaidRemaining=`${PREPAID_DELIVERIES_PER_DAY}-${prepaidUsedSql(dateSQL)}`;
    const result = await this.db.query(`
      SELECT w.id::text, w.fulfillment_type, w.starts_at, w.ends_at, w.order_opens_at, w.order_cutoff_at, w.capacity, w.total_order_capacity,
             COALESCE((SELECT full_payment_required FROM delivery_date_limits WHERE delivery_date=${dateSQL}),FALSE) AS date_full_payment_required,
             ${remaining} AS remaining, (${prepaidRemaining})::int AS prepaid_remaining, (${dayRemaining})::int AS daily_remaining, ${type === 'pickup' ? 'TRUE' : 'FALSE'} AS pickup_available
      FROM delivery_windows w
      LEFT JOIN orders o ON o.delivery_window_id = w.id
        AND ${deliveryCapacitySql('o')} AND (o.status IN ('confirmed', 'fulfilled', 'payment_review') OR (o.status = 'awaiting_payment' AND o.payment_expires_at > $1))
      WHERE w.status = 'open' AND (w.order_opens_at IS NULL OR w.order_opens_at <= $1) AND w.starts_at > $1 AND date_trunc('week', w.starts_at AT TIME ZONE 'America/Bogota') = (SELECT min(date_trunc('week', starts_at AT TIME ZONE 'America/Bogota')) FROM delivery_windows WHERE ends_at > $1) AND w.order_cutoff_at > $1 AND w.fulfillment_type = $2
      GROUP BY w.id
      ${includeFull || type === 'pickup' || allowPrepaid ? '' : `HAVING ${remaining} > 0`}
      ORDER BY w.starts_at
    `, [now, 'delivery']);
    const rows=(result.rows as Array<Record<string, any>>).map(w=>this.cfg.NEW_ORDERS_FULL_PAYMENT||w.date_full_payment_required?{...w,date_full_payment_required:true,prepayment_required:true}:w);
    const paymentOpen=(w:Record<string,any>)=>new Date(w.starts_at).getTime()-12*3600000>Date.now();
    for(const w of rows){
      if(w.total_order_capacity!=null||this.cfg.NEW_ORDERS_TOTAL_CAP){
        const {remaining}=await exactWindowCapacity(this.db,w,this.cfg.NEW_ORDERS_TOTAL_CAP,now);
        w.remaining=remaining;w.daily_remaining=remaining;w.prepaid_remaining=0;w.pickup_available=type==='pickup'&&remaining>0;
      }
    }
    if(this.cfg.NEW_ORDERS_TOTAL_CAP)return includeFull?rows:rows.filter(w=>w.remaining>0&&paymentOpen(w));
    if(includeFull)return rows;
    if(!allowPrepaid||type==='pickup')return rows.filter(w=>(w.total_order_capacity==null||w.remaining>0)&&(!w.date_full_payment_required||paymentOpen(w)));
    // On dates requiring advance payment, expose all remaining capacity together:
    // normal seats plus the existing additional prepaid allowance, never twice.
    return rows.flatMap(w=>{
      if(w.total_order_capacity!=null)return w.remaining>0&&paymentOpen(w)?[w]:[];
      if(w.date_full_payment_required){
        const remaining=Math.max(0,w.remaining)+Math.max(0,w.prepaid_remaining);
        return remaining>0&&paymentOpen(w)?[{...w,regular_remaining:w.remaining,remaining,daily_remaining:Math.max(0,w.daily_remaining)+Math.max(0,w.prepaid_remaining),prepayment_required:true}]:[];
      }
      return w.remaining>0?[w]:w.prepaid_remaining>0&&paymentOpen(w)?[{...w,regular_remaining:w.remaining,remaining:w.prepaid_remaining,daily_remaining:w.prepaid_remaining,prepayment_required:true}]:[];
    });
  }

  async create(input: {
    scheduled?: {kind:'delivery'|'pickup';startsAt:string;address:string;area?:string;point?:{lat:number;lng:number};pinConfirmed?:boolean};
    phone: string; displayName?: string; idempotencyKey?:string; cart: CartLine[]; fulfillmentType: 'delivery' | 'pickup';
    reviewNotes?: string[]; extrasDeclined?: boolean; fullPrepayment?: boolean; windowId: string; deliveryAddress?: string; deliveryContactPhones?: string[]; deliverySingleContactAccepted?:boolean; deliveryCoverage?: DeliveryCoverage; referralCode?: string; expectedTotalCop?: number; expectedMenuVersion?: number;
  }) {
    if (this.cfg.BOT_MODE !== 'ordering') throw new Error('Los pedidos todavía no están abiertos');
    if (this.cfg.NEW_ORDERS_PAUSED && !(this.cfg.SCHEDULED_ORDERING_ENABLED && input.scheduled && this.cfg.NEW_ORDERS_PAUSE_REASON==='grand_opening')) throw new Error(orderingPauseReply(this.cfg));
    // Enforce the current policy at checkout too, including old drafts and staff
    // handoffs. Existing orders retain the payment terms stored when created.
    input={...input,fullPrepayment:this.cfg.NEW_ORDERS_FULL_PAYMENT||input.fullPrepayment};
    requireBotAccess(this.cfg, input.phone);
    const cod = this.payments.name === 'cash_on_delivery';
    const pickup=(input.deliveryCoverage?.method??input.deliveryCoverage?.preference??input.fulfillmentType)==='pickup';
    let deliveryCoverage=pickup?{...(input.deliveryCoverage??coverageSnapshot({municipality:null,area:null},'pickup')),preference:'pickup' as const,method:'pickup' as const,needsReview:false}:input.deliveryCoverage;
    if(input.deliveryContactPhones?.length) {
      const count=input.deliveryContactPhones.length;
      if(!(count===2||count===1&&input.deliverySingleContactAccepted===true)||new Set(input.deliveryContactPhones).size!==count||input.deliveryContactPhones.some(p=>!/^\+[1-9]\d{7,14}$/.test(p)))throw new Error('Faltan teléfonos de contacto válidos y diferentes');
      // Adding contacts must not introduce a new coverage review for legacy checkout.
      deliveryCoverage={...(deliveryCoverage??{status:'unknown',label:'Sin evaluación de cobertura registrada',policyVersion:'contacts-only',preference:null,needsReview:false}),contactPhones:[...input.deliveryContactPhones],singleContactAccepted:count===1&&input.deliverySingleContactAccepted===true};
    }
    const now = DateTime.now().toUTC();
    const created:CreatedOrder = await this.db.transaction(async (tx) => {
      const iso = now.toISO()!;
      if(input.scheduled && (!this.cfg.SCHEDULED_ORDERING_ENABLED || input.scheduled.kind!==input.fulfillmentType || input.scheduled.address!==input.deliveryAddress || pickup!==(input.scheduled.kind==='pickup')))throw new Error('Datos del pedido inconsistentes.');
      const scheduled=input.scheduled?await prepareScheduledCheckout(tx,input.scheduled,input.phone,input.idempotencyKey,now):null;
      if(scheduled?.prior)return scheduled.prior;
      if(scheduled)input={...input,windowId:scheduled.windowId!};
      if(this.cfg.POS_RUNTIME_ENABLED){await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR UPDATE');if(input.idempotencyKey){const prior=(await tx.query<{phone:string;response:any}>('SELECT * FROM pos_checkouts WHERE key=$1',[input.idempotencyKey])).rows[0];if(prior){if(prior.phone!==input.phone)throw new Error('Identificador de pedido inválido');return prior.response;}}}
      const central=(await tx.query<{version:number;derived?:{deliveryEquipmentCost:number;deliveryCostMissing:boolean}}>('SELECT version,derived FROM costing_state WHERE id=1 FOR SHARE')).rows[0];
      const menuVersion=central?.version??0;
      if(input.expectedMenuVersion!==undefined&&input.expectedMenuVersion!==menuVersion)throw new Error('Confirma el resumen y el total de tu pedido antes de continuar.');
      await tx.query(`UPDATE orders SET status = 'expired', updated_at = $1 WHERE status = 'awaiting_payment' AND payment_expires_at <= $1`, [iso]);
      const delivery=usesDeliveryCapacity({delivery_coverage:deliveryCoverage,fulfillment_type:input.fulfillmentType});
      const zone=delivery?(deliveryCoverage?.destinationZone??specialDeliveryZone(locationFromAddress(input.deliveryAddress??''))):null;
      if(zone&&zone!=='itagui')throw new Error('Zona especial inválida');
      const limits=scheduled?{fullPaymentRequired:false,date:null,day:12,window:3}:await lockDeliveryCapacity(tx,input.windowId,zone);
      const windowResult = await tx.query<any>(scheduled?'SELECT * FROM delivery_windows WHERE id=$1 FOR UPDATE':"SELECT * FROM delivery_windows WHERE id=$1 AND status='open' FOR UPDATE", [input.windowId]);
      const window = windowResult.rows[0];
      const target = (await tx.query<any>(`SELECT min(date_trunc('week', starts_at AT TIME ZONE 'America/Bogota'))::text AS week FROM delivery_windows WHERE ends_at > $1`, [iso])).rows[0]?.week;
      const windowWeek = window ? DateTime.fromISO(window.starts_at).setZone('America/Bogota').startOf('week').toISODate() : null;
      if (!scheduled && ((!window?.pos_enabled&&(!target || windowWeek !== String(target).slice(0,10))) || !window || window.fulfillment_type !== 'delivery' || window.starts_at <= iso || (window.order_opens_at && window.order_opens_at > iso) || window.order_cutoff_at <= iso)) {
        throw new Error('La franja ya cerró sus prepedidos');
      }
      if(this.cfg.POS_RUNTIME_ENABLED&&!window.pos_enabled)throw new Error('Elige una franja de servicio actual.');
      if(!scheduled&&(window.total_order_capacity!=null||this.cfg.NEW_ORDERS_TOTAL_CAP)){
        const {remaining}=await exactWindowCapacity(tx,window,this.cfg.NEW_ORDERS_TOTAL_CAP,iso);
        if(remaining<=0)throw new Error('Los cupos de esta franja se agotaron.');
      }
      if (!input.deliveryAddress?.trim()) throw new Error('Falta la dirección de entrega');
      if(limits.fullPaymentRequired&&!input.fullPrepayment)throw new Error('Esta fecha requiere pago completo anticipado por transferencia.');

      if(zone){
        deliveryCoverage={...(deliveryCoverage??coverageSnapshot(locationFromAddress(input.deliveryAddress??''))),status:'inside',needsReview:false,method:'delivery',destinationZone:zone,capacityZone:zone,label:'Itagüí · ruta especial con pago completo anticipado'};
      }else if(deliveryCoverage){
        // Capacity tags are assigned only by the locked checkout above.
        deliveryCoverage={...deliveryCoverage};delete deliveryCoverage.capacityZone;
      }
      let prepaidDelivery=false;
      if(delivery&&!scheduled&&!window.pos_enabled&&!this.cfg.NEW_ORDERS_TOTAL_CAP&&window.total_order_capacity==null){
        const used=await deliveryCapacityUsed(tx,input.windowId,limits.date,iso,null,zone);
        if(used.daily>=limits.day||used.window>=limits.window){
          if(zone)throw new Error('Los cupos para Itagüí en esta franja se agotaron');
          if(!input.fullPrepayment)throw new Error(used.daily>=limits.day?'La fecha acaba de llenarse':'La franja acaba de llenarse');
          const count=(await tx.query<{used:number}>(`SELECT ${prepaidUsedSql('$2::date')} AS used`,[iso,limits.date])).rows[0]!.used;
          if(count>=PREPAID_DELIVERIES_PER_DAY)throw new Error('Los cupos con pago completo del día se agotaron');
          prepaidDelivery=true;
        }
      }

      await tx.query(`
        INSERT INTO customers (id, phone_e164, display_name, locale, created_at, updated_at)
        VALUES ($1, $2, $3, 'es-CO', $4, $4)
        ON CONFLICT(phone_e164) DO UPDATE SET display_name = COALESCE(excluded.display_name, customers.display_name), updated_at = excluded.updated_at
      `, [randomUUID(), input.phone, input.displayName ?? null, iso]);
      const customer = (await tx.query<{ id: string }>('SELECT id::text FROM customers WHERE phone_e164 = $1', [input.phone])).rows[0]!;

      if (!input.cart.length || input.cart.some(line => !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 100)) throw new Error('Cantidad inválida');
      if (!input.cart.length) throw new Error('El carrito está vacío');
      const ids = [...new Set(input.cart.map((line) => line.menuItemId))];
      const itemsResult = await tx.query<MenuRow>(`
        SELECT id::text, sku, name, description, category, price_cop, metadata_json::text,menu_version,slug
        FROM menu_items WHERE active = TRUE AND (id::text = ANY($1::text[]) OR slug=ANY($1::text[]))
      `, [ids]);
      const items = itemsResult.rows;
      if(ids.some(id=>!items.some(i=>i.id===id||i.slug===id)))throw new Error('Un producto del pedido no existe o está inactivo. Elige un producto del menú actual');
      if(!items.some(item=>item.category==='plate'))throw new Error('El pedido necesita al menos un plato activo');
      for(const line of input.cart) {
        const item=items.find(i=>i.id===line.menuItemId||i.slug===line.menuItemId)!;
        const p=JSON.parse(item.metadata_json).kitchen?.product;
        const c=line.customization;
        if(c?.wholePiece){
          const kind=crabKind(item);
          if(!kind||c.wholePiece!==(kind==='snow'?'racimo_entero':'pata_entera')||!Number.isSafeInteger(c.wholePieceCount)||c.wholePieceCount!<=0||(p.unit==='g'?!c.finalWeightPending||!Number.isFinite(c.estimatedWeightGrams)||Math.abs(c.estimatedWeightGrams!-line.quantity*p.baseQuantity)>0.00001:c.finalWeightPending!==false||c.wholePieceCount!==line.quantity))throw new Error('Revisa la cantidad y el peso estimado de la pieza entera');
        }
        if(p?.unit==='g') {if(Math.abs(line.quantity*p.baseQuantity*1000-Math.round(line.quantity*p.baseQuantity*1000))>0.00001)throw new Error('Usa hasta tres decimales en los gramos');}
        else if(!Number.isSafeInteger(line.quantity))throw new Error('Las unidades de este producto deben ser enteras');
      }
      await checkStock(tx,input.cart.map(l=>({slug:items.find(i=>i.id===l.menuItemId||i.slug===l.menuItemId)!.slug??'',quantity:l.quantity})));
      const heats = [...new Set(input.cart.map(l => l.customization?.spice).filter(Boolean))];
      const snapshots = input.cart.map(line => snapshotKitchenLine(items.find(i => i.id === line.menuItemId||i.slug===line.menuItemId)!, line, heats.length === 1 ? heats[0] : undefined));
      const itemMap = new Map<string,MenuRow>();
      for(const item of items){itemMap.set(item.id,item);if(item.slug)itemMap.set(item.slug,item);}
      const subtotal = input.cart.reduce((sum, line) => sum + lineCharge(itemMap.get(line.menuItemId)!.price_cop,line.quantity), 0);


      const deliveryFee=delivery?(scheduled?15000:Number((await tx.query<{delivery_fee_cop:number}>('SELECT delivery_fee_cop FROM checkout_settings WHERE id=1 FOR SHARE')).rows[0]?.delivery_fee_cop ?? 0)):0;
      let deliveryDiscount=0;
      let referralId: string | null = null;
      let referralSnapshot: string | null = null;
      if (input.referralCode) {
        const referralResult = await tx.query<{ id: string; code: string; free_delivery:boolean }>(`
          SELECT id::text, code, free_delivery FROM referral_codes WHERE lower(code) = lower($1) AND active = TRUE
          AND (valid_from IS NULL OR valid_from <= $2) AND (valid_until IS NULL OR valid_until >= $2)
        `, [input.referralCode, iso]);
        if (!referralResult.rows[0]) throw new Error('El código de referido ya no es válido');
        referralId = referralResult.rows[0].id;
        referralSnapshot = referralResult.rows[0].code;
        deliveryDiscount=referralResult.rows[0].free_delivery ? deliveryFee : 0;
      }

      const total=subtotal+deliveryFee-deliveryDiscount;
      if (input.expectedTotalCop !== undefined && total !== input.expectedTotalCop) throw new Error('Confirma el resumen y el total de tu pedido antes de continuar.');
      // Payment choice survives switching to pickup or a customer's courier.
      // Only prepaidDelivery (capacity accounting) depends on our delivery route.
      const fullPayment=input.fullPrepayment===true;
      const deposit = !fullPayment && cod && total > paymentPolicy.depositAboveCop ? paymentPolicy.depositCop : 0;
      const paymentAmount = deposit || total;
      const paymentProvider = (deposit||fullPayment) ? 'manual_transfer' : this.payments.name;
      const orderId = randomUUID();
      const token = randomBytes(4).toString('hex').toUpperCase();
      const publicId = `KC-${token.slice(0, 6)}`;
      const reference = `KC${token}`;
      // Manual transfers reserve the slot until the kitchen's 12-hour reconciliation deadline.
      const expiresAt = scheduled?now.plus({minutes:15}):cod && !deposit && !fullPayment ? DateTime.fromISO(window.ends_at) : paymentProvider === 'manual_transfer' ? (window.pos_enabled?DateTime.min(now.plus({minutes:15}),DateTime.fromISO(window.order_cutoff_at)):DateTime.fromISO(window.starts_at).toUTC().minus({hours:12})) : DateTime.min(now.plus({ minutes: 30 }), DateTime.fromISO(window.order_cutoff_at));
      if(fullPayment&&expiresAt<=now)throw new Error('El plazo para verificar el pago completo ya cerró');
      await tx.query(`
        INSERT INTO orders
          (id, public_id, customer_id, delivery_window_id, referral_code_id, fulfillment_type, delivery_address, status,
           subtotal_cop, total_cop, payment_reference, payment_expires_at, created_at, updated_at, referral_code_snapshot,menu_version,delivery_cost_snapshot,delivery_cost_missing,delivery_fee_cop,delivery_discount_cop)
        VALUES ($1, $2, $3, $4, $5, $19, $6, $15, $16, $7, $8, $9, $10, $10, $11,$12,$13,$14,$17,$18)
      `, [orderId, publicId, customer.id, input.windowId, referralId, input.deliveryAddress.trim(), total, reference, expiresAt.toISO(), iso, referralSnapshot,menuVersion||null,delivery?central?.derived?.deliveryEquipmentCost??null:0,delivery?central?.derived?.deliveryCostMissing??null:false,cod&&!deposit&&!fullPayment?'confirmed':'awaiting_payment',subtotal,deliveryFee,deliveryDiscount,'delivery']);
      await tx.query('UPDATE orders SET prepaid_delivery=$2,full_payment_required=$3,extras_declined=$4 WHERE id=$1',[orderId,prepaidDelivery,fullPayment,input.extrasDeclined===true]);
      await tx.query("UPDATE delivery_waitlist SET status='ordered',updated_at=$3,updated_by='checkout' WHERE customer_id=$1 AND delivery_window_id=$2 AND status IN ('waiting','contacted')",[customer.id,input.windowId,iso]);
      // Shared scheduled windows retain the legacy delivery type; coverage.method is the fulfillment authority.
      if(deliveryCoverage)await tx.query('UPDATE orders SET delivery_coverage=$2::jsonb WHERE id=$1',[orderId,JSON.stringify(deliveryCoverage)]);
      const wholeNotes=input.cart.filter(l=>l.customization?.wholePiece).map(l=>wholePieceNote(l.customization));
      if(input.reviewNotes?.length)wholeNotes.push('REVISAR PEDIDO:\n'+input.reviewNotes.map(n=>'• '+n).join('\n'));
      if(wholeNotes.length)await tx.query('UPDATE orders SET notes=$2 WHERE id=$1',[orderId,wholeNotes.join('\n')]);
      const heatBags=new Set<string>();
      for (const [index, line] of input.cart.entries()) {
        const item = itemMap.get(line.menuItemId)!;
        const costing=JSON.parse(item.metadata_json).costing;
        const heat=snapshots[index]?.heat;
        const modifier=heat&&!heatBags.has(heat)?costing?.heats?.find((h:any)=>h.key===heat):null;
        if(heat)heatBags.add(heat);
        const costSnapshot=costing?{...costing,name:item.name,unitPrice:item.price_cop,quantity:line.quantity,totalCost:costing.unitCost*line.quantity+(modifier?.cost??0),heatCost:modifier?.cost??0,missing:[...costing.missing,...(modifier?.missing?[modifier.ingredientKey]:[])]}:null;
        await tx.query(`
          INSERT INTO order_line_items (id, order_id, menu_item_id, item_name_snapshot, quantity, unit_price_cop, line_total_cop, customization_json, kitchen_snapshot_json,costing_snapshot_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,$10::jsonb)
        `, [randomUUID(), orderId, item.id, item.name, line.quantity, item.price_cop, lineCharge(item.price_cop,line.quantity), JSON.stringify(line.customization ?? {}), snapshots[index] ? JSON.stringify(snapshots[index]) : null, costSnapshot?JSON.stringify(costSnapshot):null]);
      }
      await tx.query(`
        INSERT INTO payments (id, order_id, provider, reference, amount_cop, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)
      `, [randomUUID(), orderId, paymentProvider, reference, paymentAmount, iso]);
      if(cod&&this.cfg.REMINDER_CONFIRMATIONS_ENABLED)await tx.query('UPDATE orders SET reminder_confirmation_required=TRUE WHERE id=$1',[orderId]);
      if (cod) {
        // Commit session completion with the order, so a failed final send cannot create it again.
        await tx.query("UPDATE conversations SET state='MAIN_MENU',context_json='{}'::jsonb,updated_at=$2 WHERE phone_e164=$1",[input.phone,iso]);
        if(!deposit&&!fullPayment) for (const reminder of [{hours:24,kind:'reminder_24h'},{hours:6,kind:'reminder_6h'}]) {
          const due=DateTime.fromISO(window.starts_at).minus({hours:reminder.hours});
          if(due>now) await tx.query(`INSERT INTO message_outbox(id,customer_id,order_id,kind,body,due_at,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)`,
            [randomUUID(),customer.id,orderId,reminder.kind,`⏰ Recordatorio de ${this.cfg.BUSINESS_NAME}: tu pedido ${publicId} es ${windowLabel(window.starts_at,window.ends_at,this.cfg.BUSINESS_TIMEZONE)}. Entrega en ${input.deliveryAddress}. Pago contra entrega.`,due.toUTC().toISO(),iso]);
        }
      }
      if(this.cfg.POS_RUNTIME_ENABLED)await attachDelivery(tx,orderId);
      const response={ orderId, publicId, reference, total, deposit, fullPayment, prepaidDelivery, paymentAmount, expiresAt: expiresAt.toISO()! };
      if(scheduled)await finishScheduledCheckout(tx,scheduled,orderId,input.phone,input.idempotencyKey,response);
      if(this.cfg.POS_RUNTIME_ENABLED&&input.idempotencyKey)await tx.query('INSERT INTO pos_checkouts(key,phone,response) VALUES($1,$2,$3::jsonb)',[input.idempotencyKey,input.phone,JSON.stringify(response)]);
      return response;
    });

    const payment: PaymentInstructions = await ((created.deposit||created.fullPayment) ? new ManualTransferPaymentProvider(this.cfg) : this.payments).createPayment({
      reference: created.reference,
      amountCop: created.paymentAmount,
      description: `Prepedido ${created.publicId} - ${this.cfg.BUSINESS_NAME}`,
      customerPhone: input.phone
    });
    if(created.fullPayment)payment.instructions=payment.instructions.replace(/abono/gi,'pago completo');
    if (payment.providerPaymentId) {
      await this.db.query(`UPDATE payments SET provider_payment_id = $1, updated_at = $2 WHERE order_id = $3`, [payment.providerPaymentId, new Date().toISOString(), created.orderId]);
    }
    return { ...created, payment };
  }


  async cancel(publicId: string, phone: string, now = new Date()) {
    return this.db.transaction(async tx => {
      if(this.cfg.POS_RUNTIME_ENABLED)await tx.query('SELECT id FROM dine_in_control WHERE id=1 FOR UPDATE');
      const order = (await tx.query<any>(`SELECT o.id, o.status, o.public_id, w.starts_at,
        EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='confirmed') AS paid
        FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
        WHERE o.public_id=$1 AND c.phone_e164=$2 FOR UPDATE OF o`, [publicId.toUpperCase(), phone])).rows[0];
      if (!order) throw new Error('No encontré ese pedido para este número de WhatsApp');
      if(this.cfg.POS_RUNTIME_ENABLED){const result=await requestDeliveryCancellation(tx,order,phone);if(result)return result;}
      if (order.status === 'cancelled') return { ...order, alreadyCancelled: true };
      if (!['awaiting_payment','confirmed','payment_review'].includes(order.status)) throw new Error('Este pedido ya no se puede cancelar');
      if (now.getTime() > new Date(order.starts_at).getTime() - 12 * 3600000) throw new Error('El plazo de cancelación cerró 12 horas antes del inicio de tu franja de entrega');
      await tx.query(`UPDATE orders SET status='cancelled', cancelled_at=$2, cancellation_reason='Cancelado por el cliente vía WhatsApp',
        refund_status=CASE WHEN $3 THEN 'pending' ELSE NULL END, updated_at=$2 WHERE id=$1`, [order.id, now.toISOString(), order.paid]);
      await tx.query(`UPDATE message_outbox SET status='cancelled' WHERE order_id=$1 AND status IN ('pending','failed')`, [order.id]);
      return { ...order, alreadyCancelled: false };
    });
  }

  async orderByPublicId(publicId: string) {
    const orderResult = await this.db.query<any>(`
      SELECT o.*, o.id::text, o.customer_id::text, o.delivery_window_id::text, o.referral_code_id::text,
             o.payment_expires_at, o.created_at, o.updated_at,
             c.phone_e164, c.display_name, w.starts_at, w.ends_at,
             r.code AS referral_code, r.influencer_name
      FROM orders o JOIN customers c ON c.id = o.customer_id
      JOIN delivery_windows w ON w.id = o.delivery_window_id
      LEFT JOIN referral_codes r ON r.id = o.referral_code_id
      WHERE o.public_id = $1
    `, [publicId]);
    const order = orderResult.rows[0];
    if (!order) return null;
    const lines = await this.db.query<any>(`SELECT item_name_snapshot AS name, quantity, unit_price_cop, line_total_cop, customization_json FROM order_line_items WHERE order_id = $1`, [order.id]);
    order.lines = lines.rows.map(({ customization_json, ...line }) => ({ ...line, customization: customization_json }));
    order.payments = (await this.db.query(`SELECT provider, provider_payment_id, reference, amount_cop, status, confirmed_at FROM payments WHERE order_id = $1`, [order.id])).rows;
    return order;
  }
}
