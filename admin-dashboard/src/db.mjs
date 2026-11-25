import {validDate} from '../public/reporting-period.js';
import {migrateFinances} from './finances.mjs';
import {migrateOpeningWaitlist} from './opening-waitlist.mjs';
import {migrateOrderExtras} from './order-extras.mjs';
import {migrateLocationConfirmation} from './location-confirmation.mjs';
import {migratePrepaidCapacity} from './prepaid-capacity.mjs';
import {migrateStaffConfirmations} from './staff-confirmations.mjs';
import {migrateReminderConfirmations} from './reminder-confirmations.mjs';
import {migrateFlow} from './flow/store.mjs';
import {migrateCosting} from './costing/schema.mjs';
import { connectPostgres } from './postgres.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, '../migrations.sql');
export async function openOrderDb(databaseUrl, suppliedDb) {
    const db = suppliedDb ?? connectPostgres(databaseUrl);
    try {
        await db.exec(readFileSync(migrationPath, 'utf8'));
        await db.exec(readFileSync(resolve(here, '../kitchen-migrations.sql'), 'utf8'));
        await migrateCosting(db);
  await migrateFlow(db);
  await migrateReminderConfirmations(db);
  await migrateStaffConfirmations(db);
  await migratePrepaidCapacity(db);
  await migrateLocationConfirmation(db);
  await migrateOrderExtras(db);
  await migrateOpeningWaitlist(db);
        await migrateFinances(db);
        await seedGoals(db);
        await ensureReferralProfiles(db);
        return db;
    }
    catch (error) {
        if (!suppliedDb)
            await db.close();
        throw error;
    }
}
async function seedGoals(db) {
    const rows = [['preorder', 'Solo preorden', 40, 2000000, 1], ['ghost_kitchen', 'Ghost kitchen completa', 200, 12000000, 2], ['restaurant', 'Restaurante físico', 900, 70000000, 3]];
    await db.transaction(async (tx) => {
        for (const row of rows)
            await tx.query(`INSERT INTO stage_goals (stage_key,label,order_target,revenue_target_cop,sort_order,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(stage_key) DO NOTHING`, [...row, new Date().toISOString()]);
    });
}
// All statements below are static SQL; placeholder values stay parameterized.
async function rows(db, sql, params) {
    let index = 0;
    return (await db.query(sql.replace(/\?/g, () => '$' + (++index)), params)).rows;
}
async function one(db, sql, params) { return (await rows(db, sql, params))[0]; }
async function run(db, sql, params) {
    let index = 0;
    return db.query(sql.replace(/\?/g, () => '$' + (++index)), params);
}
export async function ensureReferralProfiles(db) {
  await db.transaction(async (tx) => {
    const codes = await tx.query(`SELECT rc.id, rc.influencer_name FROM referral_codes rc
      LEFT JOIN referral_code_profiles p ON p.referral_code_id = rc.id WHERE p.referral_code_id IS NULL`);
    for (const code of codes.rows) {
      const creator = await tx.query(`INSERT INTO influencers (id,name,active,created_at,updated_at)
        VALUES ($1,$2,TRUE,now(),now()) ON CONFLICT (lower(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [randomUUID(),code.influencer_name]);
      await tx.query(`INSERT INTO referral_code_profiles (referral_code_id,influencer_id,created_at,updated_at)
        VALUES ($1,$2,now(),now()) ON CONFLICT DO NOTHING`,[code.id,creator.rows[0].id]);
    }
  });
}
const bogotaDayStart = (date) => date ? `${date}T05:00:00.000Z` : null;
const bogotaDayEnd = (date) => {
    if (!date)
        return null;
    const end = new Date(`${date}T05:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return end.toISOString();
};
export function normalizeFilters(query) {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const from = typeof query.from === 'string' && validDate(query.from) ? query.from : null;
    const to = typeof query.to === 'string' && validDate(query.to) ? query.to : null;
    const allowedStatuses = new Set(['awaiting_payment', 'confirmed', 'delivery_review', 'payment_review', 'expired', 'cancelled', 'fulfilled']);
    const status = typeof query.status === 'string' && allowedStatuses.has(query.status) ? query.status : null;
    const requestedWindows=typeof query.window==='string'?query.window.split(','):[];
    const windowIds=requestedWindows.length>1&&requestedWindows.length<=20&&requestedWindows.every(id=>/^[a-f0-9-]{36}$/i.test(id))?[...new Set(requestedWindows)]:null;
    const windowId = !windowIds && typeof query.window === 'string' && query.window.length < 100 ? query.window : null;
    return { from, to, status, windowId, windowIds, dateBasis:query.basis==='delivery'?'delivery':'created' };
}
function orderFilter(filters, alias = 'o') {
    const dateColumn=filters.dateBasis==='delivery'?`(SELECT dw.starts_at FROM delivery_windows dw WHERE dw.id=${alias}.delivery_window_id)`:`${alias}.created_at`;
    const clauses = [];
    const params = [];
    if (filters.from) {
        clauses.push(`${dateColumn} >= ?`);
        params.push(bogotaDayStart(filters.from));
    }
    if (filters.to) {
        clauses.push(`${dateColumn} < ?`);
        params.push(bogotaDayEnd(filters.to));
    }
    if (filters.status) {
        clauses.push(`${operationalStatus(alias)} = ?`);
        params.push(filters.status);
    }
    if (filters.windowIds?.length) {
        clauses.push(`${alias}.delivery_window_id IN (${filters.windowIds.map(()=>'?').join(',')})`);
        params.push(...filters.windowIds);
    } else if (filters.windowId) {
        clauses.push(`${alias}.delivery_window_id = ?`);
        params.push(filters.windowId);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
function spendFilter(filters, alias = 'ms') {
    const clauses = [];
    const params = [];
    if (filters.from) {
        clauses.push(`${alias}.spent_at >= ?`);
        params.push(bogotaDayStart(filters.from));
    }
    if (filters.to) {
        clauses.push(`${alias}.spent_at < ?`);
        params.push(bogotaDayEnd(filters.to));
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
const paidExists = (alias = 'o') => `(${alias}.status IN ('confirmed','fulfilled') AND EXISTS (SELECT 1 FROM payments px WHERE px.order_id = ${alias}.id AND px.status = 'confirmed') AND COALESCE((SELECT SUM(px.amount_cop) FROM payments px WHERE px.order_id = ${alias}.id AND px.status = 'confirmed'),0) >= ${alias}.total_cop)`;
// Receipt evidence is separate from money received. A pending review disappears
// once that payment is confirmed, even if its historical metadata is retained.
const paymentVerificationSql = (alias = 'o') => `(SELECT px.raw_payload_json->'verificationReview' FROM payments px WHERE px.order_id=${alias}.id AND px.status='pending' AND px.raw_payload_json->'verificationReview'->>'status'='pending' ORDER BY px.updated_at DESC,px.id LIMIT 1)`;
// A saved request is not a confirmed order. COD is valid without an upfront
// payment, but unresolved delivery/pickup arrangements are never confirmed.
const readyOrder = (alias = 'o') => `(${alias}.status IN ('confirmed','fulfilled')
  AND COALESCE((${alias}.delivery_coverage->>'needsReview')::boolean,FALSE)=FALSE
  AND EXISTS (SELECT 1 FROM payments px WHERE px.order_id=${alias}.id AND (px.status='confirmed' OR px.provider='cash_on_delivery')))`;
const operationalStatus = (alias = 'o') => `(CASE
  WHEN ${alias}.status IN ('confirmed','awaiting_payment','payment_review') AND COALESCE((${alias}.delivery_coverage->>'needsReview')::boolean,FALSE) THEN 'delivery_review'
  WHEN ${alias}.status='confirmed' AND NOT ${readyOrder(alias)} THEN 'payment_review'
  ELSE ${alias}.status END)`;
const pendingOrder = (alias = 'o') => `(${alias}.status IN ('confirmed','awaiting_payment','payment_review') AND NOT ${readyOrder(alias)})`;
// Reporting rows for every matching active order, independent of the 100-row
// dispatch table. Only confirmed payments count as money received.
export async function paymentOrders(db, filters) {
    const where = orderFilter(filters);
    return rows(db, `
      SELECT o.public_id, ${operationalStatus()} AS status, ${readyOrder()} AS is_confirmed,
        o.total_cop, o.created_at, c.display_name, c.phone_e164, ${paymentVerificationSql()} AS payment_verification,
        CASE WHEN c.phone_e164 ~ '^[+][1-9][0-9]{7,14}$' THEN c.phone_e164 ELSE o.delivery_coverage->'contactPhones'->>0 END AS contact_phone,
        w.starts_at, w.ends_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'slug',COALESCE(l.costing_snapshot_json->>'slug',l.kitchen_snapshot_json->>'slug',mi.slug),
          'name',l.item_name_snapshot,'quantity',l.quantity,'section',mi.pricing_spec->>'section') ORDER BY l.id)
          FROM order_line_items l JOIN menu_items mi ON mi.id=l.menu_item_id WHERE l.order_id=o.id),'[]'::jsonb) AS line_items,
        COALESCE(p.collected_cop,0)::int AS collected_cop,
        COALESCE(refunds.refunded_cop,0)::int AS refunded_cop,
        (COALESCE(p.collected_cop,0)-COALESCE(refunds.refunded_cop,0))::int AS net_collected_cop,
        GREATEST(0,o.total_cop-COALESCE(p.collected_cop,0))::int AS balance_due_cop
      FROM orders o
      JOIN customers c ON c.id=o.customer_id
      JOIN delivery_windows w ON w.id=o.delivery_window_id
      LEFT JOIN (SELECT order_id,SUM(amount_cop) AS collected_cop FROM payments WHERE status='confirmed' GROUP BY order_id) p ON p.order_id=o.id
      LEFT JOIN (SELECT reference,SUM(amount_cop) AS refunded_cop FROM finance_entries WHERE category='refund' AND direction='out' AND NOT voided GROUP BY reference) refunds ON refunds.reference=o.public_id
      ${where.sql}${where.sql ? ' AND' : ' WHERE'} o.status NOT IN ('cancelled','expired')
      ORDER BY w.starts_at,o.created_at,o.id
    `, where.params);
}
export async function dashboardSnapshot(db, filters) {
    await ensureReferralProfiles(db);
    const where = orderFilter(filters);
    const spendWhere = spendFilter(filters);
    const orderSummary = (await one(db, `
    SELECT COUNT(*) FILTER (WHERE ${readyOrder()}) AS orders_count,
      COUNT(*) FILTER (WHERE ${pendingOrder()}) AS pending_requests_count,
      COALESCE(SUM(CASE WHEN ${paidExists()} THEN 1 ELSE 0 END),0) AS paid_orders_count,
      COALESCE(SUM(CASE WHEN ${paidExists()} THEN o.total_cop ELSE 0 END), 0) AS revenue_cop
    FROM orders o ${where.sql}
  `, [...where.params]));
    const costSummary = (await one(db, `
    SELECT COALESCE(SUM(CASE WHEN COALESCE((oli.costing_snapshot_json->>'unitCost')::numeric, CASE WHEN mi.pricing_spec IS NULL THEN mi.cost_cop ELSE NULL END) IS NOT NULL THEN COALESCE((oli.costing_snapshot_json->>'totalCost')::numeric, oli.quantity * CASE WHEN mi.pricing_spec IS NULL THEN mi.cost_cop ELSE NULL END) ELSE 0 END), 0)::float8 AS known_cost_cop,
      COALESCE(SUM(CASE WHEN (COALESCE((oli.costing_snapshot_json->>'unitCost')::numeric, CASE WHEN mi.pricing_spec IS NULL THEN mi.cost_cop ELSE NULL END) IS NULL OR COALESCE(jsonb_array_length(oli.costing_snapshot_json->'missing'),0)>0) THEN oli.quantity ELSE 0 END), 0)::float8 AS missing_cost_units
    FROM orders o
    JOIN order_line_items oli ON oli.order_id = o.id
    JOIN menu_items mi ON mi.id = oli.menu_item_id
    ${where.sql}${where.sql ? ' AND' : ' WHERE'} ${paidExists()}
  `, [...where.params]));
    const deliveryCosts = await one(db, `SELECT COALESCE(SUM(o.delivery_cost_snapshot),0)::float8 AS cost, COUNT(*) FILTER (WHERE o.delivery_cost_missing=true)::int AS missing FROM orders o ${where.sql}${where.sql?' AND':' WHERE'} ${paidExists()}`, [...where.params]);
    costSummary.known_cost_cop += deliveryCosts.cost;
    costSummary.missing_cost_units += deliveryCosts.missing;
    const orders = (await rows(db, `
    SELECT o.full_payment_required,o.prepaid_delivery,o.reminder_confirmation_required,o.cancellation_reason,o.refund_status, ${paymentVerificationSql()} AS payment_verification,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',m.kind,'status',m.status,'delivered_at',m.delivery_confirmed_at,'deadline_at',m.confirmation_deadline_at,'confirmed_at',m.confirmation_received_at) ORDER BY m.due_at) FROM message_outbox m WHERE m.order_id=o.id AND m.kind IN ('reminder_24h','reminder_6h')),'[]'::jsonb) AS reminders,
      o.notes,o.delivery_cost_snapshot,o.delivery_cost_missing,o.public_id, ${operationalStatus()} AS status, o.status AS source_status, o.fulfillment_type, o.total_cop, o.subtotal_cop, o.delivery_address, o.delivery_coverage, o.delivery_fee_cop, o.delivery_discount_cop AS discount_cop, o.created_at,
      EXISTS(SELECT 1 FROM whatsapp_chat_controls cc WHERE cc.customer_phone=c.phone_e164 AND cc.manual_paused_at IS NOT NULL) AS chat_manual_paused, (SELECT paused_until FROM whatsapp_chat_controls cc WHERE cc.customer_phone=c.phone_e164 AND cc.paused_until>now()) AS chat_paused_until,c.display_name, c.phone_e164, w.id AS window_id, w.starts_at, w.ends_at,
      COALESCE(o.referral_code_snapshot, rc.code) AS referral_code,
      (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS payment_status,
      COALESCE((SELECT SUM(p.amount_cop) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed'),0)::int AS collected_cop,
      (SELECT p.amount_cop FROM payments p WHERE p.order_id=o.id ORDER BY p.created_at DESC LIMIT 1) AS expected_payment_cop,
      (SELECT p.provider FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS payment_provider,
      COALESCE((SELECT SUM(COALESCE((oli.costing_snapshot_json->>'totalCost')::numeric, oli.quantity * CASE WHEN mi.pricing_spec IS NULL THEN mi.cost_cop ELSE NULL END)) FROM order_line_items oli JOIN menu_items mi ON mi.id = oli.menu_item_id WHERE oli.order_id = o.id AND COALESCE((oli.costing_snapshot_json->>'unitCost')::numeric, CASE WHEN mi.pricing_spec IS NULL THEN mi.cost_cop ELSE NULL END) IS NOT NULL), 0)::float8 AS known_cost_cop,
      COALESCE((SELECT SUM(CASE WHEN (COALESCE((oli.costing_snapshot_json->>'unitCost')::numeric, CASE WHEN mi.pricing_spec IS NULL THEN mi.cost_cop ELSE NULL END) IS NULL OR COALESCE(jsonb_array_length(oli.costing_snapshot_json->'missing'),0)>0) THEN oli.quantity ELSE 0 END) FROM order_line_items oli JOIN menu_items mi ON mi.id = oli.menu_item_id WHERE oli.order_id = o.id), 0)::float8 AS missing_cost_units
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN delivery_windows w ON w.id = o.delivery_window_id
    LEFT JOIN referral_codes rc ON rc.id = o.referral_code_id
    ${where.sql}
    ORDER BY o.created_at DESC LIMIT 100
  `, [...where.params])).map((row) => ({
        ...row,
        payment_status: row.collected_cop>0 && row.collected_cop<row.total_cop ? 'partial' : row.payment_status,
        balance_due_cop: Math.max(0,row.total_cop-row.collected_cop),
        estimated_profit_cop: row.collected_cop>=row.total_cop && row.payment_status === 'confirmed' && row.missing_cost_units === 0 && row.delivery_cost_missing!==true
            ? row.total_cop - row.known_cost_cop - Number(row.delivery_cost_snapshot??0)
            : null
    }));
    const daily = (await rows(db, `
    SELECT (${filters.dateBasis==='delivery'?"(SELECT dw.starts_at FROM delivery_windows dw WHERE dw.id=o.delivery_window_id)":'o.created_at'} AT TIME ZONE 'America/Bogota')::date::text AS day,
      COUNT(*) FILTER (WHERE ${readyOrder()}) AS orders_count,
      COUNT(*) FILTER (WHERE ${pendingOrder()}) AS pending_requests_count,
      COALESCE(SUM(CASE WHEN ${paidExists()} THEN o.total_cop ELSE 0 END), 0) AS revenue_cop
    FROM orders o ${where.sql}
    GROUP BY day ORDER BY day
  `, [...where.params]));
    const statuses = (await rows(db, `
    SELECT ${operationalStatus()} AS status, COUNT(*) AS orders_count FROM orders o ${where.sql}
    GROUP BY ${operationalStatus()} ORDER BY orders_count DESC
  `, [...where.params]));
    const codeRows = (await rows(db, `
    SELECT rc.id, rc.code, rc.influencer_name, rc.active, rc.free_delivery,
      rc.valid_from, rc.valid_until,
      p.influencer_id, p.campaign_name, p.content_url,
      i.handle AS influencer_handle, i.platform AS influencer_platform,
      COUNT(DISTINCT o.id) FILTER (WHERE ${readyOrder()}) AS attributed_orders,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL AND ${paidExists()} THEN o.total_cop ELSE 0 END), 0) AS revenue_cop
    FROM referral_codes rc
    LEFT JOIN referral_code_profiles p ON p.referral_code_id = rc.id
    LEFT JOIN influencers i ON i.id = p.influencer_id
    LEFT JOIN orders o ON o.referral_code_id = rc.id
      ${where.sql ? `AND ${where.sql.slice(6)}` : ''}
    GROUP BY rc.id, p.referral_code_id, i.id
    ORDER BY revenue_cop DESC, attributed_orders DESC, rc.code
  `, [...where.params]));
    const spends = (await rows(db, `
    SELECT ms.id, ms.influencer_id, ms.referral_code_id, ms.campaign_name, ms.amount_cop, ms.spent_at, ms.notes,
      i.name AS influencer_name, rc.code AS referral_code
    FROM marketing_spend ms
    LEFT JOIN influencers i ON i.id = ms.influencer_id
    LEFT JOIN referral_codes rc ON rc.id = ms.referral_code_id
    ${spendWhere.sql}
    ORDER BY ms.spent_at DESC, ms.created_at DESC
  `, [...spendWhere.params]));
    const codeSpend = new Map();
    for (const spend of spends) {
        if (spend.referral_code_id)
            codeSpend.set(spend.referral_code_id, (codeSpend.get(spend.referral_code_id) ?? 0) + spend.amount_cop);
    }
    const codes = codeRows.map((code) => {
        const spendCop = codeSpend.get(code.id) ?? 0;
        return {
            ...code,
            spend_cop: spendCop,
            roi: spendCop > 0 ? (code.revenue_cop - spendCop) / spendCop : null
        };
    });
    const influencerRows = (await rows(db, `SELECT id, name, handle, platform, active FROM influencers ORDER BY name`, []));
    const influencers = influencerRows.map((influencer) => {
        const ownedCodes = codes.filter((code) => code.influencer_id === influencer.id);
        const ownedSpends = spends.filter((spend) => spend.influencer_id === influencer.id);
        const spendCop = ownedSpends.reduce((sum, spend) => sum + spend.amount_cop, 0);
        const revenueCop = ownedCodes.reduce((sum, code) => sum + code.revenue_cop, 0);
        return {
            ...influencer,
            codes: ownedCodes.map((code) => code.code),
            orders: ownedCodes.reduce((sum, code) => sum + code.attributed_orders, 0),
            revenue_cop: revenueCop,
            spend_cop: spendCop,
            roi: spendCop > 0 ? (revenueCop - spendCop) / spendCop : null
        };
    }).sort((a, b) => b.revenue_cop - a.revenue_cop);
    const goals = (await rows(db, `SELECT * FROM stage_goals ORDER BY sort_order`, []));
    const lifetime = (await one(db, `
    SELECT COUNT(*) AS paid_orders_count, COALESCE(SUM(total_cop), 0) AS revenue_cop
    FROM orders o WHERE ${paidExists()}
  `, []));
    const enrichedGoals = goals.map((goal) => ({
        ...goal,
        order_progress: Math.min(lifetime.paid_orders_count / goal.order_target, 1),
        revenue_progress: Math.min(lifetime.revenue_cop / goal.revenue_target_cop, 1),
        completed: lifetime.paid_orders_count >= goal.order_target && lifetime.revenue_cop >= goal.revenue_target_cop
    }));
    const activeGoal = enrichedGoals.find((goal) => !goal.completed)?.stage_key ?? enrichedGoals.at(-1)?.stage_key;
    const windows = (await rows(db, `
    SELECT id, fulfillment_type, starts_at, ends_at, status FROM delivery_windows ORDER BY starts_at DESC LIMIT 60
  `, []));
    const demoSeed = (await one(db, `SELECT value FROM admin_metadata WHERE key = 'demo_seed'`, []));
    return {
        source: {
            database: 'WhatsApp ordering system',
            last_order_at: (await one(db, 'SELECT MAX(created_at) AS value FROM orders', [])).value,
            demo_seeded: demoSeed?.value === 'true'
        },
        filters: { ...filters, windows },
        kpis: {
            orders_count: orderSummary.orders_count,
            pending_requests_count: orderSummary.pending_requests_count,
            paid_orders_count: orderSummary.paid_orders_count,
            revenue_cop: orderSummary.revenue_cop,
            known_cost_cop: costSummary.known_cost_cop,
            missing_cost_units: costSummary.missing_cost_units,
            estimated_profit_cop: costSummary.missing_cost_units === 0
                ? orderSummary.revenue_cop - costSummary.known_cost_cop
                : null,
            marketing_spend_cop: spends.reduce((sum, spend) => sum + spend.amount_cop, 0)
        },
        daily,
        statuses,
        orders,
        payment_orders: await paymentOrders(db, filters),
        staff_confirmations: await rows(db,`SELECT e.customer_phone,e.body,e.sent_at,e.outcome,e.detail,o.public_id,c.display_name FROM whatsapp_staff_events e LEFT JOIN orders o ON o.id=e.order_id LEFT JOIN customers c ON c.phone_e164=e.customer_phone WHERE e.outcome IN ('applied','needs_review','paused') ORDER BY e.received_at DESC LIMIT 30`,[]),
        codes,
        influencers,
        spends,
        goals: enrichedGoals,
        active_goal: activeGoal
    };
}
export async function addSpend(db, input) {
    const now = new Date().toISOString();
    const id = randomUUID();
    (await run(db, `
    INSERT INTO marketing_spend
      (id, influencer_id, referral_code_id, campaign_name, amount_cop, spent_at, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, input.influencerId || null, input.referralCodeId || null, input.campaignName, input.amountCop, input.spentAt, input.notes || null, now]));
    return { id };
}
export async function updateGoal(db, stageKey, input) {
    const result = (await run(db, `
    UPDATE stage_goals SET order_target = ?, revenue_target_cop = ?, target_date = ?, updated_at = ?
    WHERE stage_key = ?
  `, [input.orderTarget, input.revenueTargetCop, input.targetDate || null, new Date().toISOString(), stageKey]));
    return result.rowCount > 0;
}
export async function createReferralCode(db, input) {
    const now = new Date().toISOString();
    return await db.transaction(async (db) => {
        let influencer;
        if (input.influencerId) {
            influencer = (await one(db, 'SELECT id, name FROM influencers WHERE id = ?', [input.influencerId]));
            if (!influencer)
                throw new Error('creator_not_found');
        }
        else {
            const existing = (await one(db, 'SELECT id FROM influencers WHERE lower(name) = lower(?)', [input.creatorName]));
            if (existing)
                throw new Error('creator_name_exists');
            influencer = { id: randomUUID(), name: input.creatorName };
            (await run(db, `
        INSERT INTO influencers (id, name, handle, platform, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, TRUE, ?, ?)
      `, [influencer.id, input.creatorName, input.creatorHandle || null, input.creatorPlatform || null, now, now]));
        }
        const codeId = randomUUID();
        try {
            (await run(db, `
        INSERT INTO referral_codes (id, code, influencer_name, active, valid_from, valid_until, created_at, free_delivery)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [codeId, input.code, influencer.name, input.active, input.validFrom || null, input.validUntil || null, now, input.freeDelivery === true]));
        }
        catch (error) {
            if (error.code === '23505')
                throw new Error('code_exists');
            throw error;
        }
        (await run(db, `
      INSERT INTO referral_code_profiles
        (referral_code_id, influencer_id, campaign_name, content_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [codeId, influencer.id, input.campaignName || null, input.contentUrl || null, now, now]));
        return { id: codeId, influencerId: influencer.id };
    });
}
export async function updateReferralCode(db, codeId, input) {
    const now = new Date().toISOString();
    return await db.transaction(async (db) => {
        const influencer = (await one(db, 'SELECT id, name FROM influencers WHERE id = ?', [input.influencerId]));
        if (!influencer)
            throw new Error('creator_not_found');
        const current = (await one(db, 'SELECT id FROM referral_codes WHERE id = ?', [codeId]));
        if (!current)
            throw new Error('code_not_found');
        try {
            (await run(db, `
        UPDATE referral_codes
        SET code = ?, influencer_name = ?, active = ?, valid_from = ?, valid_until = ?, free_delivery = ?
        WHERE id = ?
      `, [input.code, influencer.name, input.active, input.validFrom || null, input.validUntil || null, input.freeDelivery === true, codeId]));
        }
        catch (error) {
            if (error.code === '23505')
                throw new Error('code_exists');
            throw error;
        }
        (await run(db, `
      INSERT INTO referral_code_profiles
        (referral_code_id, influencer_id, campaign_name, content_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(referral_code_id) DO UPDATE SET
        influencer_id = excluded.influencer_id,
        campaign_name = excluded.campaign_name,
        content_url = excluded.content_url,
        updated_at = excluded.updated_at
    `, [codeId, influencer.id, input.campaignName || null, input.contentUrl || null, now, now]));
        return { id: codeId, influencerId: influencer.id };
    });
}
