import { config } from '../src/config.js';
import { createDb } from '../src/db/index.js';

const db = await createDb(config.DATABASE_URL);
const migrations = (await db.query<{ version: number; name: string; applied_at: string }>(
  `SELECT version, name, applied_at FROM schema_migrations ORDER BY version`
)).rows;
console.log('Migraciones listas:', migrations);
await db.close();
