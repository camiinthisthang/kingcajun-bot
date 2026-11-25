ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS cost_cop INTEGER CHECK (cost_cop IS NULL OR cost_cop >= 0);

CREATE TABLE IF NOT EXISTS influencers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT,
  platform TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS influencers_name_ci_uq ON influencers(lower(name));

CREATE TABLE IF NOT EXISTS referral_code_profiles (
  referral_code_id UUID PRIMARY KEY REFERENCES referral_codes(id) ON DELETE CASCADE,
  influencer_id UUID REFERENCES influencers(id) ON DELETE SET NULL,
  campaign_name TEXT,
  content_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_spend (
  id UUID PRIMARY KEY,
  influencer_id UUID REFERENCES influencers(id) ON DELETE SET NULL,
  referral_code_id UUID REFERENCES referral_codes(id) ON DELETE SET NULL,
  campaign_name TEXT NOT NULL,
  amount_cop INTEGER NOT NULL CHECK (amount_cop >= 0),
  spent_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS marketing_spend_date_idx ON marketing_spend(spent_at);
CREATE INDEX IF NOT EXISTS marketing_spend_influencer_idx ON marketing_spend(influencer_id);
CREATE INDEX IF NOT EXISTS marketing_spend_referral_idx ON marketing_spend(referral_code_id);

CREATE TABLE IF NOT EXISTS stage_goals (
  stage_key TEXT PRIMARY KEY CHECK (stage_key IN ('preorder', 'ghost_kitchen', 'restaurant')),
  label TEXT NOT NULL,
  order_target INTEGER NOT NULL CHECK (order_target > 0),
  revenue_target_cop INTEGER NOT NULL CHECK (revenue_target_cop > 0),
  target_date TEXT,
  sort_order INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
