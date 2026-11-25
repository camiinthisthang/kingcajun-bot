import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, configSchema } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createTestDb } from '../src/db/index.js';
import { buildRuntime } from '../src/runtime.js';
import { Dialog360WhatsAppProvider, isWhatsAppConfigured, parseMetaMessages } from '../src/providers/whatsapp.js';
import { whatsappAddress } from '../src/lib/whatsapp-recipient.js';
import { canUseBot } from '../src/lib/bot-access.js';

const cfg = { ...config, NODE_ENV: 'test' as const, BOT_MODE: 'standby' as const,
  WHATSAPP_PROVIDER: '360dialog' as const, D360_API_KEY: 'test-provider-key',
  D360_WEBHOOK_SECRET: 'test-webhook-secret-with-at-least-32-characters', WHATSAPP_PHONE_NUMBER_ID: 'business-phone',
  WHATSAPP_TOKEN: '', META_APP_SECRET: '', DATABASE_URL: 'pglite://:memory:' };
const inbound = (id: string, field = 'messages', phoneId = cfg.WHATSAPP_PHONE_NUMBER_ID) => ({ object: 'whatsapp_business_account', entry: [{changes: [{field,value: {
  metadata: {phone_number_id: phoneId}, contacts: [{profile: {name: 'Test'}}],
  messages: [{id,from:'573000001234',type:'text',text:{body:'hola'}}]
}}]}] });
afterEach(() => vi.restoreAllMocks());
const usernameInbound = (id: string) => {
  const payload:any=inbound(id);
  const value=payload.entry[0].changes[0].value;
  value.contacts=[{user_id:'US.123456789012345',profile:{name:'Test',username:'test_customer'}}];
  delete value.messages[0].from;
  value.messages[0].from_user_id='US.123456789012345';
  return payload;
};

describe('360dialog connection', () => {
  it.each([null,'0','invalid','10'])('backs off on rate limits instead of retrying immediately (Retry-After: %s)',async(retryAfter)=>{
    vi.useFakeTimers();
    try{
      const network=vi.spyOn(globalThis,'fetch')
        .mockResolvedValueOnce(new Response('Too many requests for one number',{status:429,headers:retryAfter===null?{}:{'retry-after':retryAfter}}))
        .mockResolvedValueOnce(new Response(JSON.stringify({messages:[{id:'recovered'}]})));
      const provider=new Dialog360WhatsAppProvider({...cfg,BOT_MODE:'ordering',BOT_AUDIENCE:'all'});
      const result=provider.sendText('+573000001234','hello');
      const wait=retryAfter==='10'?10_000:6_000;
      await vi.advanceTimersByTimeAsync(wait-1);
      expect(network).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({messageId:'recovered'});
      expect(network).toHaveBeenCalledTimes(2);
    }finally{vi.useRealTimers();}
  });

  it('parses username-only messages without inventing a phone number and retains phone compatibility',()=>{
    expect(parseMetaMessages(usernameInbound('username'),cfg.WHATSAPP_PHONE_NUMBER_ID)).toEqual([
      {eventId:'username',phone:'bsuid:US.123456789012345',displayName:'Test · @test_customer',text:'hola'}
    ]);
    expect(parseMetaMessages(inbound('phone'))[0]!.phone).toBe('+573000001234');
    expect(()=>whatsappAddress('@test_customer')).toThrow('Invalid WhatsApp');
    expect(()=>whatsappAddress('bsuid:123456789012345')).toThrow('Invalid WhatsApp');
    const privateCfg={...cfg,BOT_AUDIENCE:'allowlist' as const,WHATSAPP_ALLOWED_NUMBERS:'+15105550123',PHONE_PREVIEW:false};
    expect(canUseBot({...privateCfg,BOT_PUBLIC_OPENS_AT:'2099-10-12T05:00:00Z'},'bsuid:US.123456789012345')).toBe(false);
    expect(canUseBot({...privateCfg,BOT_PUBLIC_OPENS_AT:'2020-10-12T05:00:00Z'},'bsuid:US.123456789012345')).toBe(true);
  });

  it('uses the opaque recipient field for username-only replies and reminders',async()=>{
    const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({messages:[{id:'sent'}]})));
    const provider=new Dialog360WhatsAppProvider({...cfg,NODE_ENV:'production',BOT_MODE:'ordering',BOT_AUDIENCE:'all'});
    const recipient='bsuid:US.123456789012345';
    await provider.sendText(recipient,'hello');
    await provider.sendButtons(recipient,'Menu',[{id:'kc:place_order',title:'Hacer pedido'}]);
    await provider.sendImage(recipient,'https://example.com/menu.jpg','Menu');
    await provider.sendReminder(recipient,'reminder_24h','',['order']);
    await provider.sendPaymentAlert(recipient,'',['paid']);
    expect(network).toHaveBeenCalledTimes(5);
    for(const [,options] of network.mock.calls){
      const body=JSON.parse(options!.body as string);
      expect(body.recipient).toBe('US.123456789012345');
      expect(body).not.toHaveProperty('to');
    }
  });

  it('delivers the main menu and enters ordering for a username-only webhook, without repeating on retries',async()=>{
    const db=await createTestDb();
    const runtime=await buildRuntime({...cfg,BOT_MODE:'ordering',BOT_AUDIENCE:'all',AI_ORDERING_ENABLED:false},db);
    const sent:any[]=[];
    const realFetch=globalThis.fetch;
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
      if(String(input)==='https://waba-v2.360dialog.io/messages'){
        sent.push(JSON.parse(options!.body as string));
        return new Response(JSON.stringify({messages:[{id:`sent-${sent.length}`}]}));
      }
      return realFetch(input,options);
    });
    const server=createApp({...cfg,BOT_MODE:'ordering',BOT_AUDIENCE:'all'},runtime).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.on('listening',resolve));
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/webhooks/whatsapp`;
    const headers={'content-type':'application/json','x-webhook-secret':cfg.D360_WEBHOOK_SECRET};
    try{
      for(let i=0;i<2;i++)expect((await fetch(url,{method:'POST',headers,body:JSON.stringify(usernameInbound('hello-user'))})).status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].interactive.action.buttons[0].reply.id).toBe('kc:place_order');
      const order=usernameInbound('start-order');
      const msg=order.entry[0].changes[0].value.messages[0];
      delete msg.text;
      msg.type='interactive';msg.interactive={button_reply:{id:'kc:place_order',title:'Hacer pedido'}};
      expect((await fetch(url,{method:'POST',headers,body:JSON.stringify(order)})).status).toBe(200);
      expect(sent.length).toBeGreaterThan(1);
      for(const body of sent){expect(body.recipient).toBe('US.123456789012345');expect(body).not.toHaveProperty('to');}
      const sessions=(await db.query('SELECT phone_e164,state FROM conversations')).rows;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.phone_e164).toBe('bsuid:US.123456789012345');
      expect(sessions[0]!.state).not.toBe('MAIN_MENU');
    }finally{
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await db.close();
    }
  });

  it('uses the provider endpoint and key for every outbound message type', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({messages:[{id:'sent'}]})));
    // Return a fresh response body for every request.
    network.mockImplementation(async () => new Response(JSON.stringify({messages:[{id:'sent'}]})));
    const provider = new Dialog360WhatsAppProvider({...cfg,NODE_ENV:'production',BOT_MODE:'ordering'});
    await provider.sendText('+573000001234','hello');
    await provider.sendImage('+573000001234','https://example.com/menu.jpg','Menu');
    await provider.sendReminder('+573000001234','reminder_24h','', ['order']);
    await provider.sendPaymentAlert('+573000001234','', ['paid']);
    expect(network).toHaveBeenCalledTimes(4);
    expect(network.mock.calls.map(([url, options]) => {
      expect(url).toBe('https://waba-v2.360dialog.io/messages');
      expect(options?.headers).toEqual({'D360-API-KEY':'test-provider-key','Content-Type':'application/json'});
      const body=JSON.parse(options!.body as string);
      expect(body.to).toBe('573000001234');
      return body.type;
    })).toEqual(['text','image','template','template']);
  });

  it('requires provider credentials before replies can be enabled', () => {
    expect(isWhatsAppConfigured(cfg)).toBe(true);
    expect(isWhatsAppConfigured({...cfg,D360_API_KEY:''})).toBe(false);
    expect(configSchema.safeParse({...cfg,BOT_MODE:'prelaunch',D360_API_KEY:''}).success).toBe(false);
    expect(configSchema.safeParse({...cfg,D360_WEBHOOK_SECRET:'short'}).success).toBe(false);
    expect(configSchema.safeParse({...cfg,D360_API_KEY:'',D360_WEBHOOK_SECRET:'',BOT_MODE:'standby'}).success).toBe(true);
    expect(configSchema.safeParse({...cfg,NODE_ENV:'production',DATABASE_URL:'postgresql://user:pass@example.invalid/db',PUBLIC_BASE_URL:'https://example.com',ADMIN_API_KEY:'test-admin',WHATSAPP_VERIFY_TOKEN:'test-verify'}).success).toBe(true);
  });

  it('ignores history, phone-app echoes, other numbers and malformed event envelopes', () => {
    expect(parseMetaMessages(inbound('live'),cfg.WHATSAPP_PHONE_NUMBER_ID)).toHaveLength(1);
    for(const field of ['history','smb_app_state_sync','smb_message_echoes']) {
      expect(parseMetaMessages(inbound('old',field),cfg.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
    }
    expect(parseMetaMessages(inbound('wrong','messages','other-number'),cfg.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
    for(const body of [null,{}, {entry:{}}, {entry:[null,{changes:{}}]}, {entry:[{changes:[null]}]}, {event:'history',data:{messages:[]}}]) {
      expect(parseMetaMessages(body,cfg.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
    }
  });

  it('authenticates incoming events, deduplicates in standby and sends nothing', async () => {
    const db=await createTestDb();
    const runtime=await buildRuntime(cfg,db);
    const server=createApp(cfg,runtime).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.on('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const headers={'content-type':'application/json','x-webhook-secret':cfg.D360_WEBHOOK_SECRET};
    try {
      const body=JSON.stringify(inbound('standby-event'));
      for(const secret of ['', 'wrong']) expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{...headers,'x-webhook-secret':secret},body})).status).toBe(401);
      for(let i=0;i<2;i++) expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',headers,body})).status).toBe(200);
      expect((await fetch(base+'/webhooks/whatsapp',{headers})).status).toBe(200);
      expect((await fetch(base+'/webhooks/whatsapp')).status).toBe(401);
      for(const field of ['history','smb_message_echoes']) expect((await fetch(base+'/webhooks/whatsapp',{method:'POST',headers,body:JSON.stringify(inbound('ignored',field))})).status).toBe(200);
      expect((await db.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0]!.n).toBe(1);
      for(const table of ['customers','orders','message_outbox']) expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(0);
      expect((await (await fetch(base+'/health')).json()).mode).toMatchObject({bot:'standby',whatsapp:'360dialog'});
      await expect(runtime.whatsapp.sendText('+573000001234','blocked')).rejects.toThrow('standby');
    } finally {
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await db.close();
    }
  });
});
