import { config } from '../src/config.js';
import { createDb, seedDb } from '../src/db/index.js';

if (config.NODE_ENV === 'production') throw new Error('Example menu seeding is disabled in production. Load the approved menu and delivery windows instead.');

const db = await createDb(config.DATABASE_URL);
await seedDb(db, config);
const counts = {
  menuItems: (await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM menu_items')).rows[0]!.n,
  windows: (await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM delivery_windows')).rows[0]!.n,
  referralCodes: (await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM referral_codes')).rows[0]!.n
};
console.log('Datos iniciales listos:', counts);
await db.close();
