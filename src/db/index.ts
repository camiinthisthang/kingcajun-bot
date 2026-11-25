import {migrateOpeningWaitlist} from '../../admin-dashboard/src/opening-waitlist.mjs';
import {migrateOrderExtras} from '../../admin-dashboard/src/order-extras.mjs';
import {migrateLocationConfirmation} from '../../admin-dashboard/src/location-confirmation.mjs';
import {migratePrepaidCapacity} from '../../admin-dashboard/src/prepaid-capacity.mjs';
import {migrateStaffConfirmations} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {migrateReminderConfirmations} from '../../admin-dashboard/src/reminder-confirmations.mjs';
import {migrateFlow} from '../../admin-dashboard/src/flow/store.mjs';
import { migrateCosting } from '../../admin-dashboard/src/costing/schema.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction as PGliteTransaction } from '@electric-sql/pglite';
import { DateTime } from 'luxon';
import pg from 'pg';
import type { Config } from '../config.js';

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));

function normalizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])) as T);
}

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface DbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(text: string): Promise<void>;
}

export interface Db extends DbClient {
  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class NeonDb implements Db {
  constructor(private readonly pool: InstanceType<typeof Pool>) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
    const result = await this.pool.query<T>(text, params);
    return { rows: normalizeRows(result.rows), rowCount: result.rowCount ?? 0 };
  }

  async exec(text: string) { await this.pool.query(text); }

  async transaction<T>(work: (tx: DbClient) => Promise<T>) {
    const client = await this.pool.connect();
    const tx: DbClient = {
      query: async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) => {
        const result = await client.query<R>(text, params);
        return { rows: normalizeRows(result.rows), rowCount: result.rowCount ?? 0 };
      },
      exec: async (text: string) => { await client.query(text); }
    };
    try {
      await client.query('BEGIN');
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

class EmbeddedPostgresDb implements Db {
  constructor(private readonly client: PGlite) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
    const result = await this.client.query<T>(text, params);
    return { rows: normalizeRows(result.rows), rowCount: result.rowCount ?? result.affectedRows ?? 0 };
  }

  async exec(text: string) { await this.client.exec(text); }

  async transaction<T>(work: (tx: DbClient) => Promise<T>) {
    return this.client.transaction(async (client: PGliteTransaction) => work({
      query: async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) => {
        const result = await client.query<R>(text, params);
        return { rows: normalizeRows(result.rows), rowCount: result.rowCount ?? result.affectedRows ?? 0 };
      },
      exec: async (text: string) => { await client.exec(text); }
    }));
  }

  async close() { await this.client.close(); }
}

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

export async function createDb(databaseUrl: string): Promise<Db> {
  let db: Db;
  if (databaseUrl.startsWith('pglite://')) {
    const location = databaseUrl.slice('pglite://'.length);
    if (location && location !== ':memory:') mkdirSync(dirname(resolve(location)), { recursive: true });
    db = new EmbeddedPostgresDb(new PGlite(location === ':memory:' ? undefined : resolve(location)));
  } else {
    db = new NeonDb(new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10_000 }));
  }
  await migrateDb(db);
  await migrateCosting(db);
  await migrateFlow(db);
  await migrateReminderConfirmations(db);
  await migrateStaffConfirmations(db);
  await migratePrepaidCapacity(db);
  await migrateLocationConfirmation(db);
  await migrateOrderExtras(db);
  await migrateOpeningWaitlist(db);
  await db.exec('ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS order_invitation_json JSONB;');
  return db;
}

export async function createTestDb() { return createDb('pglite://:memory:'); }

export async function migrateDb(db: Db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = await db.query<{ version: number }>(`SELECT version FROM schema_migrations WHERE version = 1`);
  if (!applied.rows[0]) await db.transaction(async (tx) => {
    await tx.exec(readFileSync(schemaPath, 'utf8'));
    await tx.query(`INSERT INTO schema_migrations (version, name) VALUES (1, 'initial_neon_schema') ON CONFLICT DO NOTHING`);
  });
  const snapshotMigration = await db.query(`SELECT version FROM schema_migrations WHERE version = 2`);
  if (!snapshotMigration.rows[0]) await db.transaction(async (tx) => {
    await tx.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_code_snapshot TEXT;
      UPDATE orders o SET referral_code_snapshot = rc.code FROM referral_codes rc
      WHERE o.referral_code_id = rc.id AND o.referral_code_snapshot IS NULL;`);
    await tx.query(`INSERT INTO schema_migrations (version,name) VALUES (2,'order_referral_snapshot') ON CONFLICT DO NOTHING`);
  });
  await db.exec(`CREATE TABLE IF NOT EXISTS delivery_date_limits (
  delivery_date DATE PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity > 0)
);
`);
  await db.exec(`ALTER TABLE delivery_windows ADD COLUMN IF NOT EXISTS order_opens_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT;
    ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS kitchen_snapshot_json JSONB;
    ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS buttons_json JSONB;`);
}

const menu = [
  { sku: 'SET-SELFIE', name: 'Selfie Bucket', category: 'plate', price: 79900, sort: 10, description: 'Camarones, almejas y mejillones; incluye 2 mazorcas, 2 papas y salchicha.', metadata: { product_type: 'set', aliases: ['selfie', 'selfie bucket', 'bucket selfie'], upsell_skus: ['ADD-CAJUN-FRIES', 'DRINK-TEA'] } },
  { sku: 'SET-BAYOU', name: 'Bayou Bucket', category: 'plate', price: 139900, sort: 20, description: 'Cangrejo de nieve, camarones y mejillones; incluye 3 mazorcas, 4 papas y salchicha.', metadata: { product_type: 'set', aliases: ['bayou', 'bayou bucket', 'bucket bayou'], upsell_skus: ['ADD-RICE', 'DRINK-TEA'] } },
  { sku: 'SET-FAMILY', name: 'Family Bucket', category: 'plate', price: 219900, sort: 30, description: 'Cangrejo, camarones, langostino de río, almejas y mejillones; incluye 4 mazorcas, 6 papas y salchicha.', metadata: { product_type: 'set', aliases: ['family', 'family bucket', 'familiar', 'bucket familiar'], upsell_skus: ['ADD-CAJUN-FRIES', 'DRINK-TEA'] } },
  { sku: 'BYO-CRAWFISH', name: 'Langostino de río', category: 'plate', price: 35900, sort: 40, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['langostino de rio', 'cangrejo de rio', 'crawfish'] } },
  { sku: 'BYO-HEADLESS-SHRIMP', name: 'Camarón sin cabeza', category: 'plate', price: 37900, sort: 41, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['camaron sin cabeza', 'camarones sin cabeza', 'headless shrimp'] } },
  { sku: 'BYO-SHRIMP', name: 'Camarón', category: 'plate', price: 32900, sort: 42, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['camaron', 'camarones', 'shrimp'] } },
  { sku: 'BYO-CLAMS', name: 'Almejas', category: 'plate', price: 29900, sort: 43, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['almeja', 'almejas', 'clams'] } },
  { sku: 'BYO-MUSSELS', name: 'Mejillones', category: 'plate', price: 29900, sort: 44, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['mejillon', 'mejillones', 'mussels'] } },
  { sku: 'BYO-PERIWINKLE', name: 'Caracoles de mar', category: 'plate', price: 28900, sort: 45, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['caracol', 'caracoles', 'periwinkle'] } },
  { sku: 'BYO-DUNGENESS', name: 'Cangrejo Dungeness', category: 'plate', price: 69900, sort: 46, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['dungeness', 'cangrejo dungeness'] } },
  { sku: 'BYO-SNOW-CRAB', name: 'Cangrejo de nieve', category: 'plate', price: 69900, sort: 47, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['cangrejo de nieve', 'snow crab'] } },
  { sku: 'BYO-KING-CRAB', name: 'Cangrejo real', category: 'plate', price: 89900, sort: 48, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['cangrejo real', 'king crab'] } },
  { sku: 'BYO-BLUE-CRAB', name: 'Cangrejo azul', category: 'plate', price: 49900, sort: 49, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['cangrejo azul', 'blue crab'] } },
  { sku: 'BYO-LOBSTER', name: 'Langosta', category: 'plate', price: 99900, sort: 50, description: 'Porción para armar tu plato.', metadata: { product_type: 'byo_protein', aliases: ['langosta', 'lobster'] } },
  { sku: 'ADD-CORN', name: 'Mazorca cajún', category: 'addon', price: 7900, sort: 60, description: 'Mazorca con mantequilla cajún.', metadata: { aliases: ['mazorca', 'mazorcas', 'maiz', 'corn', 'corn on the cob'] } },
  { sku: 'ADD-POTATO', name: 'Papas cocidas', category: 'addon', price: 6900, sort: 61, description: 'Tres papas cocidas.', metadata: { aliases: ['papas', 'papas cocidas', 'papa cocida', 'potato', 'potatoes', 'boiled potatoes'] } },
  { sku: 'ADD-SAUSAGE', name: 'Salchicha andouille', category: 'addon', price: 9900, sort: 62, description: 'Diez rodajas.', metadata: { aliases: ['salchicha', 'andouille'] } },
  { sku: 'ADD-RICE', name: 'Arroz al vapor', category: 'addon', price: 6900, sort: 63, description: 'Porción individual.', metadata: { aliases: ['arroz', 'arroz al vapor'] } },
  { sku: 'ADD-VEGGIES', name: 'Vegetales al vapor', category: 'addon', price: 7900, sort: 64, description: 'Porción individual.', metadata: { aliases: ['vegetales', 'verduras'] } },
  { sku: 'ADD-COLESLAW', name: 'Ensalada coleslaw', category: 'addon', price: 7900, sort: 65, description: 'Porción individual.', metadata: { aliases: ['coleslaw', 'ensalada de col'] } },
  { sku: 'ADD-CAJUN-FRIES', name: 'Papas fritas cajún', category: 'addon', price: 11900, sort: 66, description: 'Porción individual.', metadata: { aliases: ['papas fritas', 'papas cajun', 'fries'] } },
  { sku: 'DRINK-TEA', name: 'Té de la casa', category: 'drink', price: 6900, sort: 70, description: 'Té frío de limón, 400 ml.', metadata: { aliases: ['un te', 'te de la casa', 'te frio'] } },
  { sku: 'DRINK-WATER', name: 'Agua con gas', category: 'drink', price: 5900, sort: 71, description: 'Botella de 300 ml.', metadata: { aliases: ['agua', 'agua con gas'] } }
] as const;

export async function seedDb(db: Db, cfg: Pick<Config, 'BUSINESS_TIMEZONE' | 'PREORDER_CUTOFF_HOURS'>) {
  const now = DateTime.now().setZone(cfg.BUSINESS_TIMEZONE);
  const iso = now.toUTC().toISO()!;
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE menu_items SET active = FALSE WHERE sku = ANY($1::text[])`, [['PLATE-CAJUN', 'PLATE-SHRIMP', 'PLATE-VEGGIE', 'ADD-MAC']]);
    const linked = (await tx.query(`SELECT id FROM menu_items WHERE metadata_json ? 'kitchen' OR slug IS NOT NULL LIMIT 1`)).rowCount > 0;
    for (const item of linked ? [] : menu) {
      await tx.query(`
        INSERT INTO menu_items
          (id, sku, name, description, category, price_cop, active, sort_order, metadata_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8::jsonb, $9, $9)
        ON CONFLICT(sku) DO UPDATE SET name = excluded.name, description = excluded.description,
          category = excluded.category, price_cop = excluded.price_cop, active = TRUE,
          sort_order = excluded.sort_order, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
      `, [randomUUID(), item.sku, item.name, item.description, item.category, item.price, item.sort, JSON.stringify(item.metadata), iso]);
    }
    for (const [code, influencer] of [['LAURA10', 'Laura Cocina'], ['SABORBOG', 'Sabor Bogotá']]) {
      await tx.query(`INSERT INTO referral_codes (id, code, influencer_name, active, created_at)
        VALUES ($1, $2, $3, TRUE, $4) ON CONFLICT DO NOTHING`, [randomUUID(), code, influencer, iso]);
    }
    const future = await tx.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM delivery_windows
      WHERE status = 'open' AND starts_at > $1 AND order_cutoff_at > $1
    `, [iso]);
    if (future.rows[0]!.count === 0) {
      for (let day = 1; day <= 3; day++) {
        const daysToSaturday = (6 - now.weekday + 7) % 7 || 7;
        const start = now.plus({ days: daysToSaturday }).startOf('day').set({ hour: 10 + day * 2 });
        await tx.query(`INSERT INTO delivery_windows
          (id, fulfillment_type, starts_at, ends_at, order_cutoff_at, capacity, status, created_at)
          VALUES ($1, 'delivery', $2, $3, $4, 25, 'open', $5)`, [randomUUID(), start.toUTC().toISO(), start.plus({ hours: 2 }).toUTC().toISO(), start.minus({ hours: cfg.PREORDER_CUTOFF_HOURS }).toUTC().toISO(), iso]);
      }
    }
  });
}
