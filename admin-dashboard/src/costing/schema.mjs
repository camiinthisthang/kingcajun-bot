// Additive schema. Runs without reading or modifying existing order snapshots.
export async function migrateCosting(db) {
 await db.exec(`
 CREATE TABLE IF NOT EXISTS checkout_settings (id INTEGER PRIMARY KEY CHECK(id=1), delivery_fee_cop INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee_cop>=0));
 INSERT INTO checkout_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
 ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS free_delivery BOOLEAN NOT NULL DEFAULT false;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_coverage JSONB;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_cop INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_discount_cop INTEGER NOT NULL DEFAULT 0;
 CREATE TABLE IF NOT EXISTS delivery_payment_reviews (order_id UUID PRIMARY KEY REFERENCES orders(id), amount_cop INTEGER NOT NULL, receipt_reference TEXT NOT NULL UNIQUE, reviewed_by TEXT NOT NULL, reviewed_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS costing_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0, source_hash TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 ALTER TABLE costing_state ADD COLUMN IF NOT EXISTS derived JSONB;
 INSERT INTO costing_state(id) VALUES(1) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS costing_settings (key TEXT PRIMARY KEY, value NUMERIC NOT NULL, unit TEXT NOT NULL, label TEXT NOT NULL, expression JSONB, note TEXT NOT NULL DEFAULT '', derived BOOLEAN NOT NULL DEFAULT false, source JSONB);
 CREATE TABLE IF NOT EXISTS ingredients (key TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, category TEXT NOT NULL, purchase_price INTEGER CHECK(purchase_price>=0), purchase_qty NUMERIC NOT NULL CHECK(purchase_qty>0), unit TEXT NOT NULL, iva_mode TEXT NOT NULL, freight BOOLEAN NOT NULL DEFAULT false, waste NUMERIC NOT NULL DEFAULT 0 CHECK(waste>=0 AND waste<1), supplier TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', source JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS recipes (key TEXT PRIMARY KEY, name TEXT NOT NULL, yield_qty NUMERIC NOT NULL CHECK(yield_qty>0), unit TEXT NOT NULL, estimated BOOLEAN NOT NULL DEFAULT false, notes TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS recipe_lines (key TEXT PRIMARY KEY, recipe_key TEXT NOT NULL REFERENCES recipes(key), ingredient_key TEXT REFERENCES ingredients(key), subrecipe_key TEXT REFERENCES recipes(key), qty NUMERIC NOT NULL CHECK(qty>=0), unit TEXT NOT NULL, expression JSONB NOT NULL, consumable BOOLEAN NOT NULL, source JSONB, CHECK((ingredient_key IS NULL) <> (subrecipe_key IS NULL)));
 ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS slug TEXT;
 CREATE UNIQUE INDEX IF NOT EXISTS menu_items_slug_unique ON menu_items(slug) WHERE slug IS NOT NULL;
 ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS pricing_spec JSONB;
 ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS menu_version INTEGER;
 ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS cost_cop NUMERIC;
 ALTER TABLE menu_items ALTER COLUMN cost_cop TYPE NUMERIC USING cost_cop::numeric;
 CREATE TABLE IF NOT EXISTS costing_drinks (key TEXT PRIMARY KEY, specification JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS costing_equipment (key TEXT PRIMARY KEY, specification JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS costing_heat (key TEXT PRIMARY KEY, specification JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS costing_ranges (key TEXT PRIMARY KEY, specification JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS price_history (version INTEGER PRIMARY KEY, actor TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), changes JSONB NOT NULL, model JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS costing_imports (source_hash TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now(), workbook JSONB NOT NULL, report JSONB NOT NULL);
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS menu_version INTEGER;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_cost_snapshot NUMERIC;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_cost_missing BOOLEAN;
 ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS costing_snapshot_json JSONB;
 ALTER TABLE order_line_items ALTER COLUMN quantity TYPE NUMERIC USING quantity::numeric;
 `);
}
