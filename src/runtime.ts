import {migrateBankMail} from '../admin-dashboard/src/bank-mail.mjs';
import {migrateScheduledOrders} from '../admin-dashboard/src/scheduled-orders.mjs';
import {migrateTableService} from '../admin-dashboard/src/table-service.mjs';
import {migratePos} from '../admin-dashboard/src/pos/runtime.mjs';
import {reconcileDeliveries} from '../admin-dashboard/src/pos/delivery.mjs';
import {createProgressDispatcher} from '../admin-dashboard/src/pos/jobs.mjs';
import type { Config } from './config.js';
import { createDb, seedDb, type Db } from './db/index.js';
import { StandbyWhatsAppProvider, DemoWhatsAppProvider, MetaWhatsAppProvider, Dialog360WhatsAppProvider, type WhatsAppProvider } from './providers/whatsapp.js';
import { CashOnDeliveryPaymentProvider, BancolombiaPaymentProvider, DemoPaymentProvider, ManualTransferPaymentProvider, type PaymentProvider } from './providers/payment.js';
import { OrderService } from './services/orders.js';
import { MessagingService } from './services/messaging.js';
import { ConversationService } from './services/conversation.js';
import { PaymentService } from './services/payments.js';
import { ReminderService } from './services/reminders.js';
import { PaymentNotificationService } from './services/payment-notifications.js';

export type Runtime = Omit<Awaited<ReturnType<typeof buildRuntime>>, 'posTick'> & {posTick?:()=>Promise<void>};

export async function buildRuntime(cfg: Config, dbOverride?: Db, refreshCatalog: () => Promise<void> = async () => {}) {
  const db = dbOverride ?? await createDb(cfg.DATABASE_URL);
  // Example products, prices and delivery windows belong only in development.
  if (cfg.NODE_ENV !== 'production') await seedDb(db, cfg);
  const whatsapp: WhatsAppProvider = cfg.BOT_MODE === 'standby' ? new StandbyWhatsAppProvider()
    : cfg.WHATSAPP_PROVIDER === 'meta' ? new MetaWhatsAppProvider(cfg)
    : cfg.WHATSAPP_PROVIDER === '360dialog' ? new Dialog360WhatsAppProvider(cfg) : new DemoWhatsAppProvider();
  const paymentProvider: PaymentProvider = cfg.PAYMENT_PROVIDER === 'cash_on_delivery' ? new CashOnDeliveryPaymentProvider() : cfg.PAYMENT_PROVIDER === 'bancolombia' ? new BancolombiaPaymentProvider(cfg) : cfg.PAYMENT_PROVIDER === 'manual_transfer' ? new ManualTransferPaymentProvider(cfg) : new DemoPaymentProvider(cfg);
  if(cfg.POS_RUNTIME_ENABLED){await migrateTableService(db);await migratePos(db);}
  if(cfg.SCHEDULED_ORDERING_ENABLED)await migrateScheduledOrders(db);
  if(cfg.BANK_MAIL_ENABLED)await migrateBankMail(db);
  const orders = new OrderService(db, cfg, paymentProvider);
  await orders.loadMenu();
  const messaging = new MessagingService(db, whatsapp, cfg.PAYMENT_QR_IMAGE_URL);
  const conversations = new ConversationService(db, cfg, orders, messaging);
  const paymentEvents = new PaymentService(db, cfg);
  const paymentNotifications = new PaymentNotificationService(cfg, messaging);
  const reminders = new ReminderService(db, whatsapp, cfg);
  const flushProgress=createProgressDispatcher(db,(payload:any,session:boolean)=>{if(!whatsapp.sendProgress)throw Object.assign(new Error('Proveedor de seguimiento no configurado.'),{code:'template_missing'});return whatsapp.sendProgress(payload.phone,payload.body,[payload.reference,payload.text],session);});
  const posTick=async()=>{if(!cfg.POS_RUNTIME_ENABLED||cfg.BOT_MODE!=='ordering')return;await reconcileDeliveries(db);await flushProgress();};
  return { posTick, refreshCatalog, db, whatsapp, paymentProvider, orders, messaging, conversations, paymentEvents, paymentNotifications, reminders };
}
