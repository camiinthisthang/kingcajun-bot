import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { InboundMessage } from '../types.js';
import { randomUUID } from 'node:crypto';
import { requireBotAccess } from '../lib/bot-access.js';
import {whatsappAddress,whatsappRecipient} from '../lib/whatsapp-recipient.js';
import {reminderButtonTemplateText,reminderButtonTemplateName} from '../services/reminder-actions.js';

export type ReminderOptions={buttons:Array<{id:string;title:string}>;sessionOpen:boolean};

export interface WhatsAppProvider {
  sendProgress?(phone:string,body:string,parameters:string[],sessionOpen:boolean):Promise<{messageId:string}>;
  sendButtons(phone: string, body: string, buttons: Array<{ id: string; title: string }>): Promise<{ messageId: string }>;
  sendText(phone: string, body: string): Promise<{ messageId: string }>;
  sendImage(phone: string, imageUrl: string, caption: string): Promise<{ messageId: string }>;
  sendReminder(phone: string, kind: 'reminder_24h' | 'reminder_6h', fallbackBody: string, parameters: string[], options?:ReminderOptions): Promise<{ messageId: string; extrasOffered?:boolean;buttonsSent?:boolean;body?:string }>;
  sendCancellation(phone:string,body:string,parameters:string[]):Promise<{messageId:string}>;
  sendPaymentAlert(phone: string, fallbackBody: string, parameters: string[]): Promise<{ messageId: string }>;
}

// No outbound path can reach Meta while the application is in standby.
export class StandbyWhatsAppProvider implements WhatsAppProvider {
  async sendButtons() { return this.sendText(); }
  async sendText(): Promise<{ messageId: string }> { throw new Error('WhatsApp sends are disabled in standby'); }
  async sendImage() { return this.sendText(); }
  async sendReminder() { return this.sendText(); }
  async sendCancellation() { return this.sendText(); }
  async sendPaymentAlert() { return this.sendText(); }
}

export class DemoWhatsAppProvider implements WhatsAppProvider {
  async sendProgress(phone:string,body:string){return this.sendText(phone,body);}
  async sendButtons(phone: string, body: string, _buttons: Array<{ id: string; title: string }>) { return this.sendText(phone, body); }
  async sendText(phone: string, body: string) {
    void phone;
    void body;
    return { messageId: `demo-${randomUUID()}` };
  }
  async sendImage(phone: string, _imageUrl: string, caption: string) {
    return this.sendText(phone, caption);
  }
  async sendReminder(phone: string, _kind: 'reminder_24h' | 'reminder_6h', fallbackBody: string, _parameters: string[],options?:ReminderOptions) {
    if(options)return {...await this.sendButtons(phone,fallbackBody,options.buttons),extrasOffered:false,buttonsSent:true};
    return {...await this.sendText(phone, fallbackBody),extrasOffered:_parameters.length===4};
  }
  async sendCancellation(phone:string,body:string,_parameters:string[]) { return this.sendText(phone,body); }
  async sendPaymentAlert(phone: string, fallbackBody: string, _parameters: string[]) {
    return this.sendText(phone, fallbackBody);
  }
}

abstract class CloudWhatsAppProvider implements WhatsAppProvider {
  constructor(protected readonly cfg: Config) {}
  protected abstract transport(): { url: string; headers: Record<string, string> };
  async sendButtons(phone: string, body: string, buttons: Array<{ id: string; title: string }>) {
    if (!buttons.length || buttons.length > 3 || buttons.some(b => !b.id || !b.title || b.title.length > 20) || body.length > 1024) throw new Error('Invalid WhatsApp reply buttons');
    return this.send(phone, { type: 'interactive', interactive: {
      type: 'button', body: { text: body },
      action: { buttons: buttons.map(reply => ({ type: 'reply', reply })) }
    } });
  }
  async sendText(phone: string, body: string) {
    return this.send(phone, { type: 'text', text: { body } });
  }
  async sendImage(phone: string, imageUrl: string, caption: string) {
    return this.send(phone, { type: 'image', image: { link: imageUrl, caption } });
  }
  async sendReminder(phone: string, kind: 'reminder_24h' | 'reminder_6h', _fallbackBody: string, parameters: string[],options?:ReminderOptions) {
    const sendTemplate=(name:string,values:string[])=>this.send(phone,{type:'template',template:{name,language:{code:'es_CO'},components:[{type:'body',parameters:values.map(text=>({type:'text',text}))}]}});
    if(options&&kind==='reminder_24h'){
      if(parameters.length!==4||options.buttons.length!==2)throw new Error('Invalid reminder button content');
      if(options.sessionOpen)return {...await this.sendButtons(phone,_fallbackBody,options.buttons),extrasOffered:false,buttonsSent:true};
      try{
        const result=await this.send(phone,{type:'template',template:{name:this.cfg.WHATSAPP_REMINDER_BUTTONS_TEMPLATE??reminderButtonTemplateName,language:{code:'es_CO'},components:[
          {type:'body',parameters:parameters.map(text=>({type:'text',text}))},
          ...options.buttons.map((button,index)=>({type:'button',sub_type:'quick_reply',index:String(index),parameters:[{type:'payload',payload:button.id}]}))
        ]}});
        return {...result,extrasOffered:false,buttonsSent:true,body:reminderButtonTemplateText.replace(/\{\{([1-4])\}\}/g,(_,n)=>parameters[Number(n)-1]!)};
      }catch(error){
        // While the new utility template is under review, retain the approved
        // reminder. Never follow an ambiguous response with another send.
        if(!(error instanceof Error)||!/\b(?:132001|132015|132016)\b/.test(error.message))throw error;
      }
      const detail=parameters[2]+' '+parameters[3]+' Responde SÍ para confirmar o CAMBIAR DIRECCIÓN.';
      return {...await sendTemplate(this.cfg.WHATSAPP_REMINDER_24H_TEMPLATE,[parameters[0]!,parameters[1]!,detail]),extrasOffered:false,buttonsSent:false,
        body:`Hola, te recordamos que tu pedido ${parameters[0]} de King Cajun tiene entrega programada para ${parameters[1]}. Detalle de entrega: ${detail}. Puedes cancelar hasta 12 horas antes del inicio de tu franja escribiendo CANCELAR seguido de la referencia del pedido. Gracias por elegirnos.`};
    }
    if(parameters.length===4&&this.cfg.WHATSAPP_REMINDER_UPSELL_TEMPLATE){
      try{return {...await sendTemplate(this.cfg.WHATSAPP_REMINDER_UPSELL_TEMPLATE,parameters),extrasOffered:true};}
      catch(error){
        // Only a definite template/category rejection may fall back. An ambiguous
        // network error might already have delivered: do not send another copy.
        if(!(error instanceof Error)||!/\b(?:100|131047|131049|132000|132001|132005|132007|132012|132015|132016)\b/.test(error.message))throw error;
      }
    }
    const name=kind==='reminder_24h'?this.cfg.WHATSAPP_REMINDER_24H_TEMPLATE:this.cfg.WHATSAPP_REMINDER_6H_TEMPLATE;
    return {...await sendTemplate(name,parameters.slice(0,3)),extrasOffered:false};
  }

  async sendCancellation(phone:string,_body:string,parameters:string[]) {
    if(!this.cfg.WHATSAPP_CANCELLATION_TEMPLATE)throw new Error('Configure an approved WhatsApp cancellation template before sending cancellation notices');
    return this.send(phone,{type:'template',template:{name:this.cfg.WHATSAPP_CANCELLATION_TEMPLATE,language:{code:'es_CO'},components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]}});
  }
  async sendPaymentAlert(phone: string, _fallbackBody: string, parameters: string[]) {
    if (this.cfg.NODE_ENV !== 'production') return this.sendText(phone, _fallbackBody);
    return this.send(phone, {
      type: 'template',
      template: {
        name: this.cfg.WHATSAPP_PAYMENT_ALERT_TEMPLATE,
        language: { code: 'es_CO' },
        components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }]
      }
    });
  }
  async sendProgress(phone:string,body:string,parameters:string[],sessionOpen:boolean) {
    requireBotAccess(this.cfg,phone);
    if(!sessionOpen&&!this.cfg.WHATSAPP_PROGRESS_TEMPLATE)throw Object.assign(new Error('Falta configurar la plantilla de seguimiento aprobada por WhatsApp.'),{code:'template_missing'});
    const content=sessionOpen?{type:'text',text:{body}}:{type:'template',template:{name:this.cfg.WHATSAPP_PROGRESS_TEMPLATE,language:{code:'es_CO'},components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]}};
    const {url,headers}=this.transport();
    // One attempt. A lost response is ambiguous: the durable worker must not
    // automatically duplicate a possibly delivered customer notification.
    const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',...whatsappAddress(phone),...content}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Object.assign(new Error(`WhatsApp rechazó el seguimiento: HTTP ${response.status}`),{retrySafe:response.status===429});
    const result=await response.json() as {messages?:Array<{id?:string}>};
    if(!result.messages?.[0]?.id)throw new Error('WhatsApp no devolvió confirmación del envío.');
    return {messageId:result.messages[0].id};
  }
  private async send(phone: string, content: Record<string, unknown>) {
    requireBotAccess(this.cfg, phone);
    const { url, headers } = this.transport();
    const body = JSON.stringify({ messaging_product: 'whatsapp', recipient_type:'individual', ...whatsappAddress(phone), ...content });
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(15_000)
        });
        if (response.ok) {
          const json = await response.json() as { messages: Array<{ id: string }> };
          return { messageId: json.messages[0]?.id ?? 'unknown' };
        }

        const details = await response.text();
        lastError = new Error(`WhatsApp error ${response.status}: ${details}`);
        const transient = response.status === 429 || response.status >= 500;
        if (!transient || attempt === 3) throw lastError;
        const retryAfter=response.headers.get('retry-after');
        const retryAfterSeconds=retryAfter?.trim()?Number(retryAfter):NaN;
        // A missing header is not a zero-second delay. Rate-limit retries must
        // leave the recipient time to recover instead of immediately failing again.
        const backoff=response.status===429?6_000*attempt:750*attempt;
        await delay(Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0?Math.max(backoff,retryAfterSeconds*1_000):backoff);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 3 || /^WhatsApp error 4(?!29)/.test(lastError.message)) throw lastError;
        await delay(attempt * 750);
      }
    }
    throw lastError ?? new Error('WhatsApp request failed');
  }
}

export class MetaWhatsAppProvider extends CloudWhatsAppProvider {
  protected transport() {
    return {
      url: `https://graph.facebook.com/${this.cfg.META_GRAPH_VERSION}/${this.cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      headers: { Authorization: `Bearer ${this.cfg.WHATSAPP_TOKEN}` }
    };
  }
}

export class Dialog360WhatsAppProvider extends CloudWhatsAppProvider {
  protected transport() {
    return { url: 'https://waba-v2.360dialog.io/messages', headers: { 'D360-API-KEY': this.cfg.D360_API_KEY } };
  }
}

export function isWhatsAppConfigured(cfg: Config) {
  if (cfg.WHATSAPP_PROVIDER === '360dialog') return Boolean(cfg.D360_API_KEY && cfg.D360_WEBHOOK_SECRET.length >= 32 && cfg.WHATSAPP_PHONE_NUMBER_ID);
  if (cfg.WHATSAPP_PROVIDER === 'meta') return Boolean(cfg.WHATSAPP_TOKEN && cfg.WHATSAPP_PHONE_NUMBER_ID && cfg.META_APP_SECRET);
  return true;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function verifyMetaSignature(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  if (!signature || signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function parseMetaMessages(payload: any, phoneNumberId?: string): InboundMessage[] {
  const result: InboundMessage[] = [];
  if (!Array.isArray(payload?.entry)) return result;
  for (const entry of payload?.entry ?? []) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry?.changes ?? []) {
      // Coexistence also delivers history, contact sync and messages sent by the
      // business phone. Only live customer messages may enter the order flow.
      if (change?.field && change.field !== 'messages') continue;
      const value = change?.value;
      if (phoneNumberId && (change?.field !== 'messages' || value?.metadata?.phone_number_id !== phoneNumberId)) continue;
      if (!Array.isArray(value?.messages)) continue;
      for (const message of value?.messages ?? []) {
        const contact=Array.isArray(value?.contacts)?value.contacts.find((c:any)=>(message?.from&&c?.wa_id===message.from)||(message?.from_user_id&&c?.user_id===message.from_user_id)):undefined;
        const profile=contact?.profile??(value?.messages?.length===1?value?.contacts?.[0]?.profile:undefined);
        const phone=whatsappRecipient(message?.from,message?.from_user_id);
        const name=profile?.username?`${profile.name?profile.name+' · ':''}@${String(profile.username).replace(/^@/,'')}`:profile?.name;
        const text = message?.text?.body ?? message?.button?.text ?? message?.interactive?.button_reply?.title ?? message?.interactive?.list_reply?.title ?? message?.image?.caption ?? message?.document?.caption;
        // Media-only messages still need a prelaunch reply. Delivery/status events do not.
        if (typeof message?.id === 'string' && phone && message?.type !== 'system') {
          const actionId = message?.interactive?.button_reply?.id ?? message?.interactive?.list_reply?.id ?? message?.button?.payload;
          result.push({ eventId: message.id, phone, displayName: name, text: typeof text === 'string' ? text : '',
            ...(/^\d+$/.test(String(message.timestamp))&&Number(message.timestamp)>0&&Number(message.timestamp)*1000<=8.64e15?{sentAt:new Date(Number(message.timestamp)*1000).toISOString()}:{}),
            ...(['image','document'].includes(message.type)&&typeof message[message.type]?.id==='string'?{media:{type:message.type,id:message[message.type].id,...(typeof message[message.type].mime_type==='string'?{mimeType:message[message.type].mime_type}:{})}}:{}),
            ...(message.type==='location'&&typeof message.location?.latitude==='number'&&typeof message.location?.longitude==='number'?{location:{lat:message.location.latitude,lng:message.location.longitude,name:message.location.name,address:message.location.address}}:{}),
            ...(typeof actionId === 'string' ? { actionId } : {}),
            ...(typeof message.context?.id==='string'?{replyToMessageId:message.context.id}:{}),
            ...(message.type === 'request_welcome' ? { requestWelcome: true } : {}) });
        } else if(typeof message?.id==='string'&&message?.type!=='system')console.warn('WhatsApp inbound message skipped: unsupported sender identifier',{type:message?.type,hasPhone:typeof message?.from==='string',hasUserId:typeof message?.from_user_id==='string'});
      }
    }
  }
  return result;
}

// Coexistence business-app messages are a separate trusted staff channel, never
// customer input. History imports and ordinary inbound messages cannot enter it.
export function parseBusinessEchoes(payload:any,phoneNumberId:string){
 const events:Array<{eventId:string;phone:string;text:string;sentAt:string}>=[];
 if(!phoneNumberId||!Array.isArray(payload?.entry))return events;
 for(const entry of payload.entry){
  if(!Array.isArray(entry?.changes))continue;
  for(const change of entry.changes){
   const value=change?.value;
   if(change?.field!=='smb_message_echoes'||value?.metadata?.phone_number_id!==phoneNumberId||!Array.isArray(value?.message_echoes))continue;
   for(const message of value.message_echoes){
    if(!['text','audio','image','video','document','sticker','location','contacts'].includes(message?.type)||typeof message?.id!=='string'||!/^\d+$/.test(String(message?.timestamp)))continue;
    if(message.type==='text'&&typeof message?.text?.body!=='string')continue;
    const business=String(value.metadata.display_phone_number??'').replace(/\D/g,'');
    if(!business||String(message.from??'').replace(/\D/g,'')!==business)continue;
    const phone=whatsappRecipient(message.to,message.to_user_id);const at=new Date(Number(message.timestamp)*1000);
    if(phone&&Number.isFinite(+at))events.push({eventId:message.id,phone,text:message.type==='text'?message.text.body:`[${message.type}]`,sentAt:at.toISOString()});
   }
  }
 }
 return events;
}
