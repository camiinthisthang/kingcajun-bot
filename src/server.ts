import {pollBankMail} from '../admin-dashboard/src/bank-mail.mjs';
import {readFileSync} from 'node:fs';
import { config } from './config.js';
import { buildRuntime } from './runtime.js';
import { createApp } from './app.js';
import { createPhonePreviewDb } from './phone-preview.js';
import {OpeningWaitlistService} from './services/opening-waitlist.js';

import {previewCatalogSource,catalogRefresher} from './preview-catalog.js';
const catalogSource=config.PHONE_PREVIEW&&config.PHONE_PREVIEW_SYNC?previewCatalogSource(config.DATABASE_URL):undefined;
const previewDb=config.PHONE_PREVIEW?await createPhonePreviewDb(catalogSource?await catalogSource.read():undefined):undefined;
const runtime = await buildRuntime(config, previewDb, catalogSource&&previewDb?catalogRefresher(previewDb,()=>catalogSource.read()):undefined);
const testDb=config.LIVE_TEST_PHONE&&config.LIVE_TEST_UNTIL&&Date.now()<Date.parse(config.LIVE_TEST_UNTIL)?await createPhonePreviewDb(JSON.parse(readFileSync('./assets/launch-test-seed.json','utf8'))):undefined;
const testConfig={...config,NEW_ORDERS_PAUSED:false,NEW_ORDERS_REOPEN_AT:undefined,BOT_AUDIENCE:'allowlist' as const,BOT_PUBLIC_OPENS_AT:undefined,WHATSAPP_ALLOWED_NUMBERS:config.LIVE_TEST_PHONE??'',PHONE_PREVIEW:true};
const testRuntime=testDb?await buildRuntime(testConfig,testDb):undefined;
const app = createApp(config, runtime,testRuntime);
const server = app.listen(config.PORT, () => {
  console.log(`${config.BUSINESS_NAME} preorder API: ${config.PUBLIC_BASE_URL}`);
  if (config.NODE_ENV !== 'production' && config.WHATSAPP_PROVIDER === 'demo') console.log(`Demo WhatsApp: ${config.PUBLIC_BASE_URL}/demo`);
});
const bankTimer=setInterval(()=>void pollBankMail(runtime.db).catch(()=>console.error('Bank email check pending')),15000);bankTimer.unref();
const timer = setInterval(() => void runtime.reminders.runDue(), config.REMINDER_POLL_MS);
timer.unref();
const posTimer=setInterval(()=>void runtime.posTick().catch(()=>console.error('POS synchronization pending; retrying')),2000);
posTimer.unref();
const openingWaitlist=new OpeningWaitlistService(runtime.db,config,()=>runtime.orders.availableWindows('delivery',false,true) as any);
const checkOpenings=()=>void openingWaitlist.runDue().catch(()=>console.error('Opening waitlist check failed'));
const openingTimer=setInterval(checkOpenings,config.REMINDER_POLL_MS);
openingTimer.unref();
checkOpenings();

function shutdown() {
  clearInterval(timer);
  clearInterval(bankTimer);
  clearInterval(posTimer);
  clearInterval(openingTimer);
  server.close(() => { void Promise.all([runtime.db.close(),testDb?.close(),catalogSource?.close()]).finally(() => process.exit(0)); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
