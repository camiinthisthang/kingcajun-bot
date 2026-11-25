CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY,
  phone_e164 TEXT NOT NULL UNIQUE,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'es-CO',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('plate', 'addon', 'drink')),
  price_cop INTEGER NOT NULL CHECK (price_cop >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_windows (
  id UUID PRIMARY KEY,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type = 'delivery'),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  order_opens_at TIMESTAMPTZ,
  order_cutoff_at TIMESTAMPTZ NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (order_cutoff_at < starts_at)
);

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL,
  influencer_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT referral_codes_code_ci_uq UNIQUE (code),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_lower_code_uq ON referral_codes (lower(code));

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  delivery_window_id UUID NOT NULL REFERENCES delivery_windows(id),
  referral_code_id UUID REFERENCES referral_codes(id),
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type = 'delivery'),
  delivery_address TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'confirmed', 'payment_review', 'expired', 'cancelled', 'fulfilled')),
  subtotal_cop INTEGER NOT NULL CHECK (subtotal_cop >= 0),
  total_cop INTEGER NOT NULL CHECK (total_cop >= 0),
  payment_reference TEXT NOT NULL UNIQUE,
  payment_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS order_line_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id),
  item_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cop INTEGER NOT NULL CHECK (unit_price_cop >= 0),
  line_total_cop INTEGER NOT NULL CHECK (line_total_cop >= 0),
  customization_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  reference TEXT NOT NULL,
  amount_cop INTEGER NOT NULL CHECK (amount_cop >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'amount_mismatch')),
  raw_payload_json JSONB,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_uq ON payments(reference);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_id_uq
  ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS windows_starts_idx ON delivery_windows(starts_at);

CREATE TABLE IF NOT EXISTS conversations (
  phone_e164 TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS message_outbox (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  order_id UUID REFERENCES orders(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  media_url TEXT,
  buttons_json JSONB,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS outbox_due_idx ON message_outbox(status, due_at);

CREATE TABLE IF NOT EXISTS operational_notifications (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  recipient_phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS operational_notifications_order_idx
  ON operational_notifications(order_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  UNIQUE(provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS delivery_date_limits (
  delivery_date DATE PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity > 0)
);
