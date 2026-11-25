import { readFileSync } from 'node:fs';
import { createDb } from './db/index.js';

/** Disposable rehearsal storage: never connects to the configured hosted database. */
export async function createPhonePreviewDb(seed = JSON.parse(readFileSync('./assets/phone-preview-seed.json', 'utf8'))) {
  const db = await createDb('pglite://:memory:');
  try {
    await db.transaction(async tx => {
      for (const table of ['menu_items', 'costing_state', 'bot_flow', 'bot_flow_history', 'delivery_windows', 'delivery_date_limits', 'referral_codes','checkout_settings']) {
        if(table==='checkout_settings'&&!seed[table])continue;
        if (!Array.isArray(seed[table])) throw new Error(`Missing phone preview seed: ${table}`);
        const columns = (await tx.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', [table])).rows;
        const types = new Map(columns.map(column => [column.column_name, column.data_type]));
        await tx.query(`DELETE FROM ${table}`);
        for (const row of seed[table]) {
          const keys = Object.keys(row);
          if (!keys.length || keys.some(key => !/^[a-z][a-z0-9_]*$/.test(key) || !types.has(key))) throw new Error(`Invalid preview columns: ${table}`);
          await tx.query(`INSERT INTO ${table} (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
            keys.map(key => types.get(key) === 'jsonb' && row[key] !== null ? JSON.stringify(row[key]) : row[key]));
        }
      }
    });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
