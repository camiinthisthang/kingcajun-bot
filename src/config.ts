import 'dotenv/config';
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('pglite://./data/preorders-pg'),
  BUSINESS_NAME: z.string().default('King Cajun'),
  BOT_MODE: z.enum(['standby', 'prelaunch', 'ordering']).default('standby'),
  SCHEDULED_ORDERING_ENABLED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  POS_RUNTIME_ENABLED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  WHATSAPP_PROGRESS_TEMPLATE: z.string().optional(),
  NEW_ORDERS_PAUSED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  NEW_ORDERS_PAUSE_REASON: z.enum(['temporary', 'capacity', 'grand_opening']).optional(),
  NEW_ORDERS_REOPEN_AT: z.string().datetime({offset:true}).optional(),
  NEW_ORDERS_TOTAL_CAP: z.coerce.number().int().positive().optional(),
  LIVE_TEST_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  LIVE_TEST_UNTIL: z.string().datetime({offset:true}).optional(),
  NEW_ORDERS_FULL_PAYMENT: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  NEW_ORDERS_CHECK_BACK_AT: z.string().datetime({offset:true}).optional(),
  BOT_PUBLIC_OPENS_AT: z.string().datetime({offset:true}).optional(),
  BOT_AUDIENCE: z.enum(['all', 'allowlist']).default('all'),
  AI_ORDERING_ENABLED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  WHATSAPP_ALLOWED_NUMBERS: z.string().default(''),
  PHONE_PREVIEW_SYNC: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  PHONE_PREVIEW: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  PRELAUNCH_REPLY: z.string().trim().min(1).max(4096).default('¡Hola! 🦞 Gracias por escribir a King Cajun. Estamos preparando nuestro menú y pronto abriremos pedidos a domicilio. Por ahora aún no estamos tomando pedidos. ¡Gracias por acompañarnos!'),
  PRELAUNCH_REPLY_COOLDOWN_HOURS: z.coerce.number().positive().max(24).default(6),
  BUSINESS_TIMEZONE: z.string().default('America/Bogota'),
  PREORDER_CUTOFF_HOURS: z.coerce.number().int().positive().default(12),
  DELIVERY_AREA_HINT: z.string().default('Medellín, Colombia'),
  MENU_IMAGE_PATH: z.string().default('./assets/menu-example.jpg'),
  MENU_IMAGE_URL: z.string().default(''),
  FAST_CHECKOUT_ENABLED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  STANDARD_SPICE: z.enum(['','Suave','Medio']).default(''),
  MENU_EXTRAS_IMAGE_URL: z.string().default(''),
  MENU_GUIDE_IMAGE_URL: z.string().url().optional(),
  BANK_NAME: z.string().default('Bancolombia'),
  BANK_ACCOUNT_TYPE: z.string().default('Ahorros'),
  BANK_ACCOUNT_NUMBER: z.string().default('000-000000-00'),
  BANK_ACCOUNT_HOLDER: z.string().default('TU EMPRESA S.A.S.'),
  WHATSAPP_PROVIDER: z.enum(['demo', 'meta', '360dialog']).default('demo'),
  D360_API_KEY: z.string().default(''),
  D360_WEBHOOK_SECRET: z.string().default(''),
  WHATSAPP_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default('change-me'),
  META_APP_SECRET: z.string().default(''),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  WHATSAPP_CANCELLATION_TEMPLATE: z.string().optional(),
  REMINDER_CONFIRMATIONS_ENABLED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  WHATSAPP_REMINDER_UPSELL_TEMPLATE: z.string().optional(),
  WHATSAPP_REMINDER_BUTTONS_TEMPLATE: z.string().optional(),
  WHATSAPP_REMINDER_24H_TEMPLATE: z.string().default('preorder_reminder_24h'),
  // The approved general reminder has no 24-hour wording and can serve both times.
  WHATSAPP_REMINDER_6H_TEMPLATE: z.string().default('preorder_reminder_24h'),
  WHATSAPP_PAYMENT_ALERT_TEMPLATE: z.string().default('payment_received_staff'),
  PAYMENT_ALERT_WHATSAPP_NUMBERS: z.string().default(''),
  PAYMENT_PROVIDER: z.enum(['demo', 'bancolombia', 'manual_transfer', 'cash_on_delivery']).default('demo'),
  BANK_MAIL_ENABLED: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  PAYMENT_QR_IMAGE_URL: z.string().url().optional(),
  MANUAL_TRANSFER_INSTRUCTIONS: z.string().trim().min(1).max(2000).default('El equipo te compartirá los datos de la cuenta por este chat. Transfiere el valor exacto e indica la referencia de tu pedido.'),
  ALLOW_DEMO_PAYMENTS_IN_PRODUCTION: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  BANCOLOMBIA_PURCHASE_INTENT_URL: z.string().default(''),
  BANCOLOMBIA_CLIENT_ID: z.string().default(''),
  BANCOLOMBIA_CLIENT_SECRET: z.string().default(''),
  BANCOLOMBIA_CALLBACK_API_KEY: z.string().default(''),
  ADMIN_API_KEY: z.string().default(''),
  INTERNAL_API_KEY: z.string().default('local-dev-key'),
  REMINDER_POLL_MS: z.coerce.number().int().positive().default(60_000)
}).superRefine((value, ctx) => {
  if (value.AI_ORDERING_ENABLED && (!value.OPENAI_API_KEY.trim() || value.PAYMENT_PROVIDER !== 'cash_on_delivery')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AI_ORDERING_ENABLED'], message: 'AI ordering requires OPENAI_API_KEY and cash_on_delivery checkout' });
  }
  if (value.PHONE_PREVIEW && (value.BOT_AUDIENCE !== 'allowlist' || value.PAYMENT_PROVIDER !== 'cash_on_delivery')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PHONE_PREVIEW'], message: 'Phone preview requires an allowlist and cash-on-delivery checkout; bank integration is disabled' });
  }
  const allowed = value.WHATSAPP_ALLOWED_NUMBERS.split(',').map(phone => phone.trim());
  if (value.BOT_AUDIENCE === 'allowlist' && allowed.some(phone => !/^\+[1-9]\d{7,14}$/.test(phone))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WHATSAPP_ALLOWED_NUMBERS'], message: 'Allowlist mode requires comma-separated international numbers, e.g. +573001234567; empty entries are not allowed' });
  }
  if (value.BOT_AUDIENCE === 'all' && value.WHATSAPP_ALLOWED_NUMBERS.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BOT_AUDIENCE'], message: 'Set BOT_AUDIENCE=allowlist to use the configured allowed numbers' });
  }
  if (value.NODE_ENV === 'production' && !value.ADMIN_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ADMIN_API_KEY'], message: 'Required in production' });
  }
  if (value.NODE_ENV === 'production' && !/^postgres(ql)?:\/\//.test(value.DATABASE_URL)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'A hosted PostgreSQL/Neon URL is required in production' });
  }
  if (value.NODE_ENV === 'production' && value.WHATSAPP_PROVIDER === 'demo') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WHATSAPP_PROVIDER'], message: 'Demo WhatsApp is disabled in production' });
  }
  if (value.NODE_ENV === 'production' && value.BOT_MODE === 'ordering' && value.PAYMENT_PROVIDER === 'demo' && !value.ALLOW_DEMO_PAYMENTS_IN_PRODUCTION) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_PROVIDER'], message: 'Demo payments require ALLOW_DEMO_PAYMENTS_IN_PRODUCTION=true' });
  }
  if (value.BOT_MODE !== 'standby' && value.WHATSAPP_PROVIDER === 'meta' && (!value.WHATSAPP_TOKEN || !value.WHATSAPP_PHONE_NUMBER_ID || !value.META_APP_SECRET)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WHATSAPP_TOKEN'], message: 'Meta credentials and app secret are required' });
  }
  if (value.WHATSAPP_PROVIDER === '360dialog') {
    if (value.D360_WEBHOOK_SECRET && value.D360_WEBHOOK_SECRET.length < 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['D360_WEBHOOK_SECRET'], message: 'Use a random webhook secret of at least 32 characters' });
    }
    if (value.BOT_MODE !== 'standby' && (!value.D360_API_KEY || !value.D360_WEBHOOK_SECRET || !value.WHATSAPP_PHONE_NUMBER_ID)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['D360_API_KEY'], message: '360dialog API key, webhook secret and phone number ID are required' });
    }
  }
  if (value.NODE_ENV === 'production' && value.BOT_MODE === 'ordering' && !['manual_transfer','cash_on_delivery'].includes(value.PAYMENT_PROVIDER) && !value.PAYMENT_ALERT_WHATSAPP_NUMBERS.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PAYMENT_ALERT_WHATSAPP_NUMBERS'], message: 'At least one staff WhatsApp number is required in production' });
  }
  if (value.NODE_ENV === 'production' && (!value.PUBLIC_BASE_URL.startsWith('https://') || value.WHATSAPP_VERIFY_TOKEN === 'change-me' || !value.WHATSAPP_VERIFY_TOKEN.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PUBLIC_BASE_URL'], message: 'Production requires HTTPS and a non-default WhatsApp verification token' });
  }
  if (value.PAYMENT_PROVIDER === 'bancolombia' && (!value.BANCOLOMBIA_PURCHASE_INTENT_URL || !value.BANCOLOMBIA_CLIENT_ID || !value.BANCOLOMBIA_CLIENT_SECRET || !value.BANCOLOMBIA_CALLBACK_API_KEY)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BANCOLOMBIA_CLIENT_ID'], message: 'Bancolombia onboarding credentials and callback key are required' });
  }
});

export type Config = z.infer<typeof configSchema>;
export function scheduledConfig(value: Config, now:()=>number=Date.now):Config {
 const paused=value.NEW_ORDERS_PAUSED;
 if(value.NEW_ORDERS_REOPEN_AT&&value.NEW_ORDERS_PAUSE_REASON!=='grand_opening')Object.defineProperty(value,'NEW_ORDERS_PAUSED',{enumerable:true,get:()=>paused && now()<Date.parse(value.NEW_ORDERS_REOPEN_AT!)});
 return value;
}
export const config = scheduledConfig(configSchema.parse(process.env));
