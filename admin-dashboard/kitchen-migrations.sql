CREATE TABLE IF NOT EXISTS kitchen_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO kitchen_catalog (id, document) VALUES (1, '{"ingredients":[],"products":[]}'::jsonb) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS kitchen_runs (
  id UUID PRIMARY KEY,
  delivery_date DATE NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 0,
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS kitchen_snapshot_json JSONB;

ALTER TABLE delivery_windows ADD COLUMN IF NOT EXISTS order_opens_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS manual_payment_reviews (
  order_id UUID PRIMARY KEY REFERENCES orders(id),
  payment_id UUID NOT NULL REFERENCES payments(id),
  amount_cop INTEGER NOT NULL,
  bank_reference TEXT NOT NULL UNIQUE,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_date_limits (
  delivery_date DATE PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity > 0)
);
