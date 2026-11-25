import {handleScheduledConversation} from './scheduled-conversation.js';
import {responseImages,restaurantAddress,restaurantHours,openingNotice,asksRestaurantLocation,asksRestaurantHours,asksAmbiguousMap} from './restaurant-information.js';
import {handlePosConversation} from './pos-conversation.js';
import {fastCheckoutCart,flagCheckout} from './fast-checkout.js';
import {withStandardSpice,standardSpiceNotice} from './standard-spice.js';
import {needsPersonalChoice} from './personal-choice.js';
import {receivePausedReminderReply} from './paused-reminder-replies.js';
import {creatorSubmission,creatorAcknowledgement,creatorLinkRequest} from './creator-submissions.js';
import {atCapacity,capacityMenuButtons,orderingPauseReply,grandOpening,openingButtons,grandOpeningConsent} from './ordering-pause.js';
import {setOpeningSubscription} from '../../admin-dashboard/src/opening-waitlist.mjs';
import {receivePreparedOrderExtras} from './prepared-order-extras.js';
import {generalMenuContext,comboFirstReply} from './catalog-presentation.js';
import {receiveOrderExtras,parseExtras,reminderReplyExtrasOffer} from './order-extras.js';
import {extrasCatalog,extrasPrompt,checkStock,stockRemaining} from '../../admin-dashboard/src/order-extras.mjs';
import {receiveLocationCorrection} from './location-confirmation.js';
import {resolveReminderAction,reminderReplyButtons,reminderNextQuestion} from './reminder-actions.js';
import {checkoutPaymentPolicy,fullPaymentNotice,advancePaymentReason,fullPaymentInstructions,contradictsFullPayment,asksPaymentInformation,choosesFullPayment} from './full-payment.js';
import {joinDeliveryWaitlist,withdrawDeliveryWaitlist} from '../../admin-dashboard/src/prepaid-capacity.mjs';
import {DateTime} from 'luxon';
import {contactNumbers,onlyOneContact,needsDeliveryContacts,deliveryContactPrompt,knownDeliveryContactDetails,receiveReminderContacts} from './delivery-contacts.js';
import {bookingType,windowAvailable} from '../../admin-dashboard/src/booking-capacity.mjs';
import {orderConfirmationNotice,deliveryWindowNotice,pickupLocationNotice} from '../../admin-dashboard/src/confirmation-notices.mjs';
import {asksPickup,asksDeliveryAvailability,mentionsDeliverySchedule,availableDeliveryReply,coverageAvailabilityReply} from './delivery-availability.js';
import {crabExplanation,prepareCrabEdits,portionConfig,refreshWholePieceDraft} from './crab-portions.js';
import {saleLineLabel,variableWeightNotice} from '../../admin-dashboard/src/crab-labels.mjs';
import {clarifyRegisteredCoverage} from './coverage-clarification.js';
import {asksBarrioName,barrioAlreadyAsked,barrioReviewNotice,limitBarrioRequest} from './barrio-clarification.js';
import {confirmReminder} from '../../admin-dashboard/src/reminder-confirmations.mjs';
import {isChatPaused,releaseManualPause} from '../../admin-dashboard/src/staff-confirmations.mjs';
import {pendingOrderInvitation,recordManualInvitation} from './order-invitations.js';
import {GeneralAssistant} from './general-assistant.js';
import {RestaurantIntent} from './restaurant-intent.js';
import {asksGenericDelivery,coverageQuestionReply,coverageSnapshot,coverageWarning,deliveryCoveragePolicy,specialDeliveryZone,literalLocation,locationFromAddress,literalAddress,destinationStatement} from './delivery-coverage.js';
import {businessFacts,paymentPolicy} from '../business-policy.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {OrderAssistant,applyCartEdits,DraftClarification,type Interpretation} from './order-assistant.js';
import {canUseBot} from '../lib/bot-access.js';
import {defaultFlow,readFlow,renderFlow} from '../../admin-dashboard/src/flow/store.mjs';
import {lineCharge} from '../../admin-dashboard/src/costing/pricing.mjs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { ConversationContext, ConversationState, InboundMessage } from '../types.js';
import { cop, deadlineLabel, deliveryAvailability, normalizeText, windowLabel } from '../lib/format.js';
import { OrderService } from './orders.js';
import { MessagingService } from './messaging.js';
import { mainMenuAction, configuredMainMenuButtons } from './main-menu.js';
import { metadata, normalizeMenuInput, parseMenuText, parseSauce, parseSpice, saucePrompt, spicePrompt } from './menu-language.js';

type Session = { state: ConversationState; context: ConversationContext };

export class ConversationService {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly orders: OrderService,
    private readonly messaging: MessagingService
  ) {}

  private readonly flow = new AsyncLocalStorage<ReturnType<typeof defaultFlow>>();
  // Production runs one replica. Serialize a phone's webhooks so two greetings
  // cannot both send the menu, and selections cannot overtake a handoff.
  private readonly pending = new Map<string, Promise<unknown>>();
  private copy(key:string,values:Record<string,unknown>={}) {return renderFlow(this.flow.getStore()??defaultFlow(),key,values);}
  private cashOnDelivery() {return this.cfg.PAYMENT_PROVIDER==='cash_on_delivery';}
  private step(key:'upsell'|'referral') {return (this.flow.getStore()??defaultFlow()).steps[key];}
  async handle(message: InboundMessage) {
    return this.serialize(message.phone,async()=>{
      const current=await readFlow(this.db);
      return this.flow.run(current.published,()=>this.handleConfigured(message));
    });
  }
  async serialize<T>(phone:string,work:()=>Promise<T>):Promise<T> {
    const previous = this.pending.get(phone) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.pending.set(phone, next);
    try { return await next; }
    finally { if (this.pending.get(phone) === next) this.pending.delete(phone); }
  }
  private async handleConfigured(message: InboundMessage) {
    if (this.cfg.BOT_MODE === 'standby') {
      // Consume the event so its retries cannot start an order after opening.
      await this.claimEvent(message);
      return { mode: 'standby' as const, replied: false };
    }
    if (!canUseBot(this.cfg, message.phone)) {
      await this.claimEvent(message);
      return { mode: 'restricted' as const, replied: false };
    }
    if (this.cfg.BOT_MODE === 'prelaunch') return this.prelaunch(message);
    if (!await this.claimEvent(message)) return { duplicate: true };
    await this.ensureCustomer(message.phone, message.displayName);
    // These commands are independent of an order draft and of the old,
    // window-specific cancellation waitlist. Opt-out is honored even during a
    // manual takeover. An explicit join always gets its confirmation without
    // resuming unrelated AI replies.
    const openingText=normalizeText(message.text).replace(/[¡!¿?.]+/g,'').trim();
    const leaveOpenings=message.actionId==='kc:opening_leave'||/^(?:salir (?:de (?:la )?)?lista(?: de espera)?|no mas avisos|dejar de recibir avisos|quitarme de la lista(?: de espera)?)$/.test(openingText);
    const joinOpenings=message.actionId==='kc:opening_join'||(!message.actionId&&/^(?:lista de espera|unirme a la lista(?: de espera)?|quiero (?:unirme|anotarme|entrar) (?:a|en) la lista(?: de espera)?)$/.test(openingText)&&atCapacity(this.cfg));
    if(leaveOpenings||joinOpenings){
      const result=await setOpeningSubscription(this.db,{phone:message.phone,eventId:message.eventId,subscribe:joinOpenings,...(grandOpening(this.cfg)?{consentText:grandOpeningConsent}:{})});
      if(leaveOpenings)await withdrawDeliveryWaitlist(this.db,message.phone);
      if(joinOpenings||!await isChatPaused(this.db,message.phone))await this.messaging.sendNow(message.phone,leaveOpenings
        ?'Listo, ya no recibirás avisos de nuevos cupos. Puedes seguir escribiéndonos sobre tu pedido o cualquier consulta. 👑'
        :grandOpening(this.cfg)?`${result.already?'Ya estás':'¡Listo! Quedaste'} en la lista para la apertura de nuestro restaurante. 🦀 Te avisaremos por WhatsApp la fecha y los detalles de la oferta de inauguración. Esto no crea un pedido. Para salir, escribe SALIR LISTA.`
        :`${result.already?'Ya estás':'¡Listo! Quedaste'} en la lista de espera. 🦀 Te avisaremos por WhatsApp cuando abramos nuevos cupos. Esto no reserva un pedido. Para dejar de recibir estos avisos, escribe SALIR LISTA.`, 'opening_subscription');
      return {openingWaitlist:leaveOpenings?'withdrawn':'subscribed'};
    }
    if(this.cfg.POS_RUNTIME_ENABLED)return handlePosConversation(this.db,this.cfg,this.orders,this.messaging,message);
    if(message.actionId==='kc:opening_order')message={...message,actionId:'kc:place_order'};
    if(message.actionId==='kc:existing_order'||/^(?:mi pedido|ya tengo (?:un )?pedido|tengo (?:un )?pedido existente)$/.test(openingText)){
      if(await isChatPaused(this.db,message.phone))return {mode:'staff_paused',replied:false};
      return this.showExistingOrders(message.phone);
    }
    if(message.replyToMessageId){
      const parent=(await this.db.query<any>(`SELECT p.provider_message_id FROM message_outbox f JOIN message_outbox p ON p.id=f.reminder_parent_id
        JOIN customers c ON c.id=f.customer_id WHERE f.provider_message_id=$1 AND c.phone_e164=$2 AND f.kind='reminder_followup_12h' AND f.status='sent'`,[message.replyToMessageId,message.phone])).rows[0];
      if(parent)message={...message,replyToMessageId:parent.provider_message_id};
    }
    if(await isChatPaused(this.db,message.phone)&&await receivePausedReminderReply(this.db,this.messaging,message))
      return {mode:'staff_paused',replied:true,reminderHandled:true};
    if(message.actionId?.startsWith('kc:reminder:')){
      if(await isChatPaused(this.db,message.phone))return {mode:'staff_paused',replied:false};
      const resolved=await resolveReminderAction(this.db,message);
      if(resolved?.error){await this.messaging.sendNow(message.phone,resolved.error,'reminder_confirmation');return {reminderAction:false};}
      if(resolved?.message)message=resolved.message;
    }
    let menuAction = mainMenuAction(message, this.flow.getStore()!.messages);
    // A deliberate top-level button tap resumes this chat immediately. Ordinary
    // text, checkout buttons and retries must not override a staff pause.
    if(message.actionId&&['order','catalog','human'].includes(menuAction??'')){
      const resumedAt=new Date().toISOString();
      await this.db.query('UPDATE whatsapp_chat_controls SET paused_until=$2,updated_at=$2,updated_by=$3 WHERE customer_phone=$1 AND paused_until>$2 AND manual_paused_at IS NULL',
        [message.phone,resumedAt,'customer-menu · '+message.eventId]);
    }
    const scheduled=await handleScheduledConversation(this.db,this.cfg,this.orders,this.messaging,message,menuAction);
    if(scheduled)return scheduled;
    let session = await this.load(message.phone);
    if(grandOpening(this.cfg)&&!message.actionId&&menuAction!=='human'&&!session.context.orderingOptIn&&!session.context.creatorSubmission&&!creatorSubmission(message.text,session.context)&&!await isChatPaused(this.db,message.phone)){
      // Older opening logic silently marked ordinary greetings as handoffs.
      // Recover only those with no recorded actual handoff or creator request.
      if(session.state==='HUMAN_HANDOFF'){
        const intentional=(await this.db.query(`SELECT 1 FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 AND m.kind IN ('human_handoff','creator_submission') LIMIT 1`,[message.phone])).rowCount>0;
        if(!intentional){session={...session,state:'MAIN_MENU'};await this.save(message.phone,session);}
      }
      if(session.state!=='HUMAN_HANDOFF')return this.answerOpeningInformation(message,session);
    }
    // Public information stays available during an ordering pause. Preserve the
    // order draft and respect human takeover; never confuse our address with a
    // customer supplying/correcting their delivery address.
    if(!message.actionId||menuAction==='catalog'){
      if(session.state!=='HUMAN_HANDOFF'&&!await isChatPaused(this.db,message.phone)){
        const location=asksRestaurantLocation(message.text),hours=asksRestaurantHours(message.text);
        if(location||hours){
          if(location)await this.messaging.sendImageNow(message.phone,this.responseImageUrl(responseImages.location),['📍 '+restaurantAddress,openingNotice()].filter(Boolean).join('\n'),'restaurant_location');
          if(hours)await this.messaging.sendImageNow(message.phone,this.responseImageUrl(responseImages.hours),[restaurantHours,openingNotice(),'Sin reservas: atendemos por orden de llegada. Recogida los días de apertura; domicilios sábados y domingos.'].filter(Boolean).join('\n'),'restaurant_hours');
          return {state:session.state,answered:true};
        }
        if(asksAmbiguousMap(message.text)){
          await this.messaging.sendNow(message.phone,'¿Buscas la ubicación del restaurante o la zona de domicilios?','map_clarification');
          return {state:session.state,answered:true};
        }
        if(menuAction==='catalog'){
          await this.sendFoodMenu(message.phone);
          return {state:session.state,answered:true};
        }
        const coverage=coverageQuestionReply(message.text);
        if(coverage){await this.sendCoverageMap(message.phone,coverage);return {state:session.state,answered:true};}
      }
    }
    // Announce closure on the first incoming message, including greetings and
    // media, without interrupting a manual takeover or blocking order support.
    let capacityNoticeSent=false;
    if(atCapacity(this.cfg)){
      if(await isChatPaused(this.db,message.phone))return {mode:'staff_paused',replied:false};
      const orderSupport=(await this.db.query(`SELECT o.id FROM orders o JOIN customers c ON c.id=o.customer_id
        WHERE c.phone_e164=$1 AND (o.status NOT IN ('cancelled','expired') OR EXISTS(
          SELECT 1 FROM message_outbox m WHERE m.order_id=o.id AND m.status='sent' AND m.kind IN ('reminder_24h','reminder_6h')
          AND (m.sent_at>now()-interval '3 days' OR m.provider_message_id=$2))) LIMIT 1`,[message.phone,message.replyToMessageId??null])).rowCount>0;
      if(!orderSupport&&menuAction!=='menu'&&!(grandOpening(this.cfg)&&menuAction==='human'))capacityNoticeSent=await this.sendCapacityNotice(message.phone);
    }
    if(!menuAction&&!message.requestWelcome&&!await isChatPaused(this.db,message.phone)){
      const submission=creatorSubmission(message.text,session.context);
      if(submission){
        const prior=session.context.creatorSubmission;
        const acknowledge=submission.hasSubmission&&!prior?.acknowledged;
        session.context.creatorSubmission={links:[...new Set([...(prior?.links??[]),...submission.links])].slice(0,30),receivedAt:prior?.receivedAt??new Date().toISOString(),acknowledged:prior?.acknowledged||acknowledge};
        session.state='HUMAN_HANDOFF';
        await this.save(message.phone,session);
        if(acknowledge||!prior)await this.messaging.sendNow(message.phone,acknowledge?creatorAcknowledgement:creatorLinkRequest,'creator_submission');
        return {state:session.state,creatorSubmission:true,replied:acknowledge||!prior};
      }
    }
    // Explicit menu actions let a creator shop later; ordinary follow-ups stay
    // with the team and never accept a sales invitation or start checkout.
    if(menuAction&&session.context.creatorSubmission){delete session.context.creatorSubmission;await this.save(message.phone,session);}
    if(!menuAction&&!this.cfg.NEW_ORDERS_PAUSED){
      const invitation=await this.acceptOrderInvitation(message);
      if(invitation)return invitation;
    }
    if(message.actionId==='kc:continue' && session.context.orderingOptIn && session.state==='UPSELL'){message={...message,actionId:undefined,text:'NO'};menuAction=undefined;}
    const reminderText=(contactNumbers(message.text).length||parseExtras(message.text).mentioned)?(message.text.match(/^\s*(CONFIRMO\s+KC-[A-Z0-9]+\s+(?:24|6)H|SI CONFIRMO|SÍ CONFIRMO|CONFIRMO|CONFIRMADO)(?=\s|[,.;]|$)/i)?.[1]??message.text):message.text;
    const locationReply=!menuAction&&!await isChatPaused(this.db,message.phone)?await receiveLocationCorrection(this.db,message,new Date(),!session.context.orderingOptIn):null;
    const reminderReply=locationReply||await isChatPaused(this.db,message.phone)?null:await confirmReminder(this.db,{...message,text:reminderText},new Date(),!session.context.orderingOptIn);
    const contactReply=!session.context.orderingOptIn&&!await isChatPaused(this.db,message.phone)?await receiveReminderContacts(this.db,message.phone,message.text):null;
    if(locationReply||reminderReply||contactReply){
      const body=[locationReply,reminderReply,contactReply].filter(Boolean).join('\n\n');
      const interactive=await reminderReplyButtons(this.db,message.phone,body);
      if(interactive)await this.messaging.sendButtonsNow(message.phone,interactive.body,interactive.buttons,'reminder_confirmation',interactive.orderId);
      else await this.messaging.sendNow(message.phone,body,reminderReply?'reminder_confirmation':'delivery_contacts');
      if(!locationReply&&!session.context.orderingOptIn&&!await isChatPaused(this.db,message.phone)){
        const extras=await receiveOrderExtras(this.db,this.cfg,message);
        if(extras)await this.messaging.sendNow(message.phone,extras.body,'extras_payment_request',extras.orderId);
        else if(await reminderNextQuestion(this.db,this.messaging,message.phone))await reminderReplyExtrasOffer(this.db,this.messaging,message.phone);
      }
      return {reminderConfirmed:!!reminderReply,contactsReceived:!!contactReply};
    }
    if(await isChatPaused(this.db,message.phone))return {mode:'staff_paused',replied:false};
    if(grandOpening(this.cfg)&&['menu','catalog','order'].includes(menuAction??''))return this.sendOrderingPaused(message.phone);
    if(atCapacity(this.cfg)){
      const supportCommand=/^(?:estado|cancelar)(?:\s|$)/i.test(message.text.trim());
      const browseOrHuman=['menu','catalog','human'].includes(menuAction??'');
      const existing=(await this.db.query(`SELECT o.id FROM orders o JOIN customers c ON c.id=o.customer_id
        WHERE c.phone_e164=$1 AND o.status NOT IN ('cancelled','expired') LIMIT 1`,[message.phone])).rowCount>0;
      // A new inquiry is still recorded for the team. Do not keep returning the
      // sold-out announcement when someone leaves event details or other notes.
      if(!existing&&!browseOrHuman&&!supportCommand&&!coverageQuestionReply(message.text)){
        // An opening announcement reply is not a request for human takeover.
        // Keep later menu/location/delivery questions available in this chat.
        if(grandOpening(this.cfg))return {mode:'capacity_closed',state:session.state,replied:capacityNoticeSent};
        await this.save(message.phone,{state:'HUMAN_HANDOFF',context:session.context});
        return {mode:'capacity_closed',state:'HUMAN_HANDOFF',replied:capacityNoticeSent};
      }
    }
    if(this.cfg.NEW_ORDERS_PAUSED){
      const supportCommand=/^(?:estado|cancelar)(?:\s|$)/i.test(message.text.trim());
      const menuOnly=['menu','catalog','human'].includes(menuAction??'');
      const newOrder=menuAction==='order'||['kc:prepay','kc:waitlist','kc:continue'].includes(message.actionId??'')||session.context.orderingOptIn||['SOLD_OUT_OPTIONS','WAITLIST_WINDOW'].includes(session.state);
      if(!menuOnly&&!supportCommand&&(newOrder||!menuAction&&await pendingOrderInvitation(this.db,message)))return this.sendOrderingPaused(message.phone);
    }
    if(!menuAction&&session.context.pendingPaymentExtrasOrderId){
      const reply=await receivePreparedOrderExtras(this.db,this.cfg,message,session.context.pendingPaymentExtrasOrderId);
      if(reply){await this.messaging.sendNow(message.phone,reply.body,reply.complete?'reservation_instructions':'conversation',reply.orderId);return {preparedOrderExtras:true,complete:reply.complete};}
    }
    if(!menuAction&&!session.context.orderingOptIn){
      const extras=await receiveOrderExtras(this.db,this.cfg,message);
      if(extras){await this.messaging.sendNow(message.phone,extras.body,'extras_payment_request',extras.orderId);return {extras:true};}
    }
    if(this.cfg.FAST_CHECKOUT_ENABLED&&!this.cfg.NEW_ORDERS_PAUSED&&!session.context.orderingOptIn&&session.state!=='HUMAN_HANDOFF'){
      const welcomed=await this.sendIntakeWelcome(message.phone);
      if(welcomed&&!message.actionId&&/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hello|hi)[.! ¡]*$/i.test(normalizeText(message.text))){
        await this.save(message.phone,{state:'MAIN_MENU',context:{}});return {state:'MAIN_MENU',replied:true};
      }
    }
    const text = normalizeText(message.text);
    // Ordinary chats opt in through the order button; a tracked invitation above
    // is the explicit alternative, never a generic yes at the main menu.
    const action = this.cfg.AI_ORDERING_ENABLED && menuAction === 'order' && message.actionId !== 'kc:place_order' ? undefined : menuAction;

    try {
      if (action === 'human') {
        const alreadyHandedOff = session.state === 'HUMAN_HANDOFF';
        await this.save(message.phone, { state: 'HUMAN_HANDOFF', context: this.cfg.AI_ORDERING_ENABLED ? session.context : {} });
        if (!alreadyHandedOff||message.actionId==='kc:human') await this.messaging.sendNow(message.phone, this.copy('human_handoff'), 'human_handoff');
        return { state: 'HUMAN_HANDOFF', replied: !alreadyHandedOff||message.actionId==='kc:human' };
      }
      if (action === 'menu' || (message.requestWelcome && session.state === 'WELCOME')) return await this.showMainMenu(message.phone);
      if (action === 'catalog') {
        await this.orders.loadMenu();
        await this.sendMenuOverview(message.phone);
        // Looking at the food menu must not discard an opted-in order.
        if(session.context.orderingOptIn && session.state!=='HUMAN_HANDOFF') {
          await this.save(message.phone,session);
          return {state:session.state};
        }
        // The existing top-level buttons remain usable. Sending them again after
        // the image adds noise and can hit WhatsApp's per-recipient rate limit.
        await this.save(message.phone, { state: 'MAIN_MENU', context: {} });
        return { state: 'MAIN_MENU', replied: true };
      }
      if (action === 'order') {
        await this.orders.loadMenu();
        if (session.state==='HUMAN_HANDOFF' && session.context.orderingOptIn && this.cfg.AI_ORDERING_ENABLED) {
          session.state='CHOOSING_ITEM'; await this.save(message.phone,session);
          return this.naturalOrder({...message,text:'Quiero continuar mi pedido'},session);
        }
        if (session.context.orderingOptIn) {
          const windows=await this.orderingWindows(session.context);
          if(!session.context.fullPrepayment&&(windows.find(w=>w.id===session.context.windowId)?.prepayment_required||windows.length>0&&windows.every(w=>w.prepayment_required)))return this.showSoldOutOptions(message.phone,session,session.context.windowId);
          await this.messaging.sendNow(message.phone, 'Ya tienes un pedido en curso. Continúa respondiendo a la última pregunta. Escribe REINICIAR para borrar el borrador y empezar de nuevo, o MENÚ para salir.');
          return { state: session.state };
        }
        return await this.welcome(message.phone);
      }
      if(/^(?:salir|quitarme|retirarme) (?:de )?(?:la )?lista(?: de espera)?$/.test(text)){
        await withdrawDeliveryWaitlist(this.db,message.phone);
        await this.save(message.phone,{state:'MAIN_MENU',context:{}});
        await this.messaging.sendNow(message.phone,'Te retiramos de la lista de espera.');return {waitlist:'withdrawn'};
      }
      if(session.state==='SOLD_OUT_OPTIONS'||session.state==='WAITLIST_WINDOW'||['kc:prepay','kc:waitlist'].includes(message.actionId??''))return this.handleSoldOutChoice(message,session);
      if(/^(?:lista de espera|quiero (?:estar|entrar|anotarme) en (?:la )?lista de espera)$/.test(text))return this.chooseWaitlistWindow(message.phone,session);
      if ((action === 'unknown' && !(session.context.checkoutExtrasPending&&/^kc:extras:(?:no|coke:[12])$/.test(message.actionId??''))) || message.requestWelcome) return { state: session.state, replied: false };
      // A handoff stays quiet until the customer explicitly chooses a menu action.
      if (session.state === 'HUMAN_HANDOFF') return { state: session.state, replied: false };
      if (text === 'estado' || text.startsWith('estado ')) {
        const code = message.text.match(/kc-[a-z0-9]+/i)?.[0]?.toUpperCase();
        const order = code ? await this.orders.orderByPublicId(code) : null;
        if (!order || order.phone_e164 !== message.phone) throw new Error('Escribe ESTADO KC-XXXXXX con un pedido de este número');
        const labels: Record<string,string> = {awaiting_payment:'Pendiente de verificación de pago por el equipo',confirmed:'Confirmado para preparar',cancelled:'Cancelado',expired:'Reserva vencida; contacta al equipo si transferiste',payment_review:'Pago en revisión',fulfilled:'Entregado'};
        await this.messaging.sendNow(message.phone, this.copy('status',{reference:order.public_id,status:(labels[order.status]||order.status)+(order.delivery_coverage?.needsReview?' · entrega pendiente de coordinación por el equipo':''),total:cop(order.total_cop)}), 'order_status', order.id);
        return { orderStatus: order.status };
      }
      if (text === 'cancelar' || text.startsWith('cancelar ')) {
        const code = message.text.match(/kc-[a-z0-9]+/i)?.[0];
        if (!code) {
          await this.messaging.sendNow(message.phone, this.copy('cancel_help'));
          return { cancellation: 'reference_needed' };
        }
        const cancelled = await this.orders.cancel(code, message.phone);
        if(cancelled.cancellationPending){await this.messaging.sendNow(message.phone,'Recibimos tu solicitud. La cancelación todavía necesita confirmación de cocina.','cancellation_requested',cancelled.id);return {cancellation:'pending'};}
        await this.messaging.sendNow(message.phone, this.copy('cancelled',{reference:cancelled.public_id,refund:cancelled.paid?' El reembolso queda pendiente de gestión; este mensaje no confirma que se haya devuelto el dinero.':''}), 'cancellation', cancelled.id);
        return { cancellation: 'cancelled' };
      }
      if(session.context.orderingOptIn&&session.context.checkoutExtrasPending){
        const extrasText=message.actionId==='kc:extras:no'?'no gracias':/^kc:extras:coke:[12]$/.test(message.actionId??'')?`${message.actionId!.split(':').at(-1)} cocas`:message.text;
        const parsed=parseExtras(extrasText);
        if(parsed.decline||parsed.mentioned||/^(si|sí|listo|continuar)$/i.test(message.text.trim())){
          await this.orders.loadMenu();
          const catalog=await extrasCatalog(this.db);
          if(session.context.menuVersion!==undefined&&session.context.menuVersion!==this.orders.menuVersion()){
            session.context.menuVersion=this.orders.menuVersion();session.context.menuSignature=this.menuSignature();
            await this.save(message.phone,session);
          }
          if(!parsed.decline&&(parsed.invalid||parsed.question||!parsed.items.length)){
            await this.messaging.sendNow(message.phone,extrasPrompt(catalog));return {state:session.state};
          }
          if(!parsed.decline){
            const cart=structuredClone(session.context.cart??[]);
            for(const line of parsed.items){
              const item=catalog.find(i=>i.slug===line.slug);
              if(!item){await this.messaging.sendNow(message.phone,'Ese extra está agotado. '+extrasPrompt(catalog));return {state:session.state};}
              this.addToCart(cart,item.id,undefined,line.quantity);
            }
            try{await checkStock(this.db,cart.map(l=>({slug:this.orders.menu().find(i=>i.id===l.menuItemId)?.slug??'',quantity:l.quantity})));}
            catch(error){await this.messaging.sendNow(message.phone,(error as Error).message);return {state:session.state};}
            session.context.cart=cart;
          }
          session.context.checkoutExtrasHandled=true;session.context.aiExtrasHandled=true;session.context.extrasDeclined=parsed.decline;
          delete session.context.checkoutExtrasPending;
          session.context.menuVersion=this.orders.menuVersion();
          await this.save(message.phone,session);
          return this.cashOnDelivery()?this.completeCashOnDelivery(message.phone,session):this.enterReferral(message.phone,'no',session);
        }
      }
      if(session.context.orderingOptIn) {
        const supplied=contactNumbers(message.text);
        const singleAccepted=session.context.awaitingDeliveryContacts&&onlyOneContact(message.text);
        if(singleAccepted)session.context.deliverySingleContactAccepted=true;
        if(supplied.length) {
          session.context.deliveryContactPhones=[...new Set([...(session.context.deliveryContactPhones??[]),...supplied])].slice(0,2);
          await this.save(message.phone,session);
        }
        if(session.context.awaitingDeliveryContacts && !/(?:combo|agrega|cambia|quita|cancel|espera|mejor|suave|medio|direcci|calle|carrera|viernes|s[áa]bado|domingo|recog|pickup)/i.test(message.text) && (singleAccepted || supplied.length || /^(si|sí|no|listo|ese|este|el mismo|mi numero|mi número)$/i.test(message.text.trim()))) {
          if(!this.cfg.FAST_CHECKOUT_ENABLED&&needsDeliveryContacts(session.context))return this.askDeliveryContacts(message.phone,session);
          delete session.context.awaitingDeliveryContacts;
          await this.save(message.phone,session);
          if(this.cashOnDelivery())return this.completeCashOnDelivery(message.phone,session);
          return this.review(message.phone,'si',session,message.displayName);
        }
      }
      if (this.cfg.AI_ORDERING_ENABLED && this.cashOnDelivery()) {
        if (!session.context.orderingOptIn) {
          const clarified=await clarifyRegisteredCoverage(this.db,this.cfg,message);
          if(clarified)return clarified;
          return this.generalQuestion(message,session);
        }
        if (['reiniciar','empezar'].includes(text) && session.context.orderingOptIn) return this.welcome(message.phone);
        if (!message.text.trim()) {
          await this.messaging.sendNow(message.phone,'Por ahora puedo ayudarte con mensajes de texto. Si enviaste un comprobante, el equipo debe revisarlo; no hace falta repetir el pedido.');
          return {state:session.state};
        }
        return await this.naturalOrder(message,session);
      }
      if (session.state === 'WELCOME') return await this.showMainMenu(message.phone);
      if (!session.context.orderingOptIn) return { state: 'MAIN_MENU', replied: false };
      if (['reiniciar', 'empezar'].includes(text)) {
        await this.orders.loadMenu();
        return await this.welcome(message.phone);
      }
      await this.save(message.phone, session);
      await this.orders.loadMenu();
      if(session.context.menuVersion!==undefined&&session.context.menuVersion!==this.orders.menuVersion()) {
        const removed=[...(session.context.cart??[]).map(l=>l.menuItemId),...(session.context.pendingSelection?.menuItemIds??[])].filter(id=>!this.orders.menu().some(i=>i.id===id));
        const signature=this.menuSignature();
        session.context.menuVersion=this.orders.menuVersion();
        if(removed.length){session.context.cart=session.context.cart?.filter(l=>this.orders.menu().some(i=>i.id===l.menuItemId));session.state='CHOOSING_ITEM';delete session.context.pendingSelection;await this.save(message.phone,session);await this.messaging.sendNow(message.phone,'Uno de los productos que elegiste no está disponible. ¿Qué te gustaría pedir en su lugar?');return {menuChanged:true};}
        if(session.context.menuSignature!==signature&&session.state==='REVIEWING'){session.context.menuSignature=signature;session.context.reviewTotalCop=(await this.orders.quote(session.context.cart??[],session.context.referralCode,session.context.deliveryPreference)).total;await this.save(message.phone,session);await this.messaging.sendNow(message.phone,await this.reviewText(session.context)+'\nResponde SÍ para confirmar tu pedido.');return {menuChanged:true};}
        session.context.menuSignature=signature;await this.save(message.phone,session);
      }
      switch (session.state) {
        case 'MAIN_MENU': return { state: session.state, replied: false };
        case 'CHOOSING_ITEM': return await this.chooseItem(message.phone, message.text, session);
        case 'CHOOSING_SAUCE': return await this.chooseSauce(message.phone, text, session);
        case 'CHOOSING_SPICE': return await this.chooseSpice(message.phone, text, session);
        case 'UPSELL': return await this.chooseUpsell(message.phone, message.text, session);
        case 'CHOOSING_FULFILLMENT': return await this.chooseFulfillment(message.phone, text, session);
        case 'CHOOSING_WINDOW': return await this.chooseWindow(message.phone, message.text, session);
        case 'ENTERING_ADDRESS': return await this.enterAddress(message.phone, message.text, session);
        case 'ENTERING_REFERRAL': return await this.enterReferral(message.phone, text, session);
        case 'REVIEWING': return await this.review(message.phone, text, session, message.displayName);
      }
    } catch (error) {
      console.error('WhatsApp conversation action failed',{action:action??'message',state:session.state,error:error instanceof Error?error.message:String(error)});
      if(this.cfg.AI_ORDERING_ENABLED) await this.messaging.sendNow(message.phone,session.context.orderingOptIn
        ? 'No pude completar ese paso. Podemos intentarlo de nuevo o puedes escribir «hablar con alguien».'
        : action==='catalog'
          ? 'No pude mostrarte la carta en este momento. Intenta tocar «Ver menú» otra vez o escribe «hablar con alguien».'
          : 'No pude responder en este momento. Intenta de nuevo o escribe «hablar con alguien».');
      else await this.messaging.sendNow(message.phone, this.copy('error',{error:error instanceof Error?error.message:'error inesperado'}));
      return { error: true };
    }
  }

  private async recentHistory(message:InboundMessage) {
    return (await this.db.query(`SELECT role,body FROM (
      SELECT 'user' AS role,payload_json->>'text' AS body,received_at AS at FROM webhook_events WHERE provider='whatsapp' AND payload_json->>'phone'=$1 AND provider_event_id<>$2
      UNION ALL SELECT 'assistant' AS role,CASE WHEN m.kind='reservation_instructions' THEN 'Pedido recibido, pendiente de pago. El bot ya envió las instrucciones de pago; el equipo debe verificar el comprobante.' ELSE m.body END AS body,m.created_at AS at FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 AND m.status='sent' AND m.kind NOT LIKE 'reminder_%'
    ) h ORDER BY at DESC LIMIT 12`,[message.phone,message.eventId])).rows.reverse().map(h=>({role:String(h.role),text:String(h.body??'').slice(0,1600)}));
  }

  private async answerOpeningInformation(message:InboundMessage,session:Session){
    const phone=message.phone;
    const topics=await new RestaurantIntent(this.cfg).classify(message.text,await this.recentHistory(message));
    if(await isChatPaused(this.db,phone))return {mode:'staff_paused',replied:false};
    if(topics.includes('human')){
      await this.save(phone,{...session,state:'HUMAN_HANDOFF'});
      await this.messaging.sendNow(phone,'Puedes dejar aquí tu pregunta para nuestro equipo.','human_handoff');
      return {state:'HUMAN_HANDOFF',replied:true};
    }
    if(topics.includes('existing_order'))return this.showExistingOrders(phone);
    let answered=false;
    if(topics.includes('menu')){await this.sendFoodMenu(phone);answered=true;}
    if(topics.includes('location')){await this.messaging.sendImageNow(phone,this.responseImageUrl(responseImages.location),'📍 '+restaurantAddress+' Hay parqueadero al lado. '+openingNotice(),'restaurant_location');answered=true;}
    if(topics.includes('hours')){await this.messaging.sendImageNow(phone,this.responseImageUrl(responseImages.hours),restaurantHours+' '+openingNotice(),'restaurant_hours');answered=true;}
    if(topics.includes('delivery')){
      await this.sendCoverageMap(phone,coverageQuestionReply(message.text)||'Sí, ofrecemos domicilios dentro de la zona del mapa.');answered=true;
    }
    if(topics.includes('pickup')){
      await this.messaging.sendNow(phone,'Puedes pedir para recoger cualquier día que abrimos: '+restaurantHours+' '+restaurantAddress+' '+openingNotice(),'pickup_information');answered=true;
    }
    if(topics.includes('ordering')&&!topics.includes('delivery')&&!topics.includes('pickup')){
      await this.messaging.sendNow(phone,'Los pedidos para domicilios se abren el lunes 23 de noviembre por este WhatsApp; entregamos sábados y domingos de 6 a 10 p. m. También puedes pedir para recoger los días de apertura. Por ahora no estamos confirmando pedidos. ¿Buscas domicilio o recogida?','ordering_information');answered=true;
    }
    if(!answered&&topics.includes('greeting'))return {state:session.state,replied:await this.sendCapacityNotice(phone)};
    if(!answered)await this.messaging.sendButtonsNow(phone,'Soy el asistente virtual de King Cajun. No tengo ese dato confirmado. Puedes tocar «Hablar con alguien» para consultarlo con nuestro equipo.',openingButtons(this.cfg),'restaurant_question');
    return {state:session.state,answered:true};
  }

  private async generalQuestion(message:InboundMessage,session:Session) {
    const phone=message.phone;
    const text=normalizeText(message.text).replace(/[¡!¿?.]+/g,'').trim();
    if(!text||/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|hi|hello|gracias|muchas gracias)$/.test(text)) {
      return session.state==='WELCOME'?this.showMainMenu(phone):{state:session.state,replied:false};
    }
    const orderLabel=this.flow.getStore()!.messages.main_menu_order;
    const routeToOrder=async(_reply='')=>{
      if(this.cfg.NEW_ORDERS_PAUSED)return this.sendOrderingPaused(phone);
      // Clear purchase intent is consent to begin; retain the original message
      // so quantities, products and delivery details reach the order interpreter.
      if(mainMenuAction(message,this.flow.getStore()!.messages)==='order')return this.welcome(phone);
      session.context.orderingOptIn=true;
      session.state='CHOOSING_ITEM';
      await this.save(phone,session);
      return this.naturalOrder(message,session);
    };
    if(mainMenuAction(message,this.flow.getStore()!.messages)==='order')return routeToOrder();
    if(/\b(?:alerg\w*|allerg\w*)/i.test(text)){
      await this.save(phone,{state:'HUMAN_HANDOFF',context:{}});
      await this.messaging.sendNow(phone,'Para una alergia necesitamos que el equipo revise los ingredientes y la preparación. No puedo asegurar que un producto sea apto. Puedes dejar aquí los detalles de tu alergia.','human_handoff');
      return {state:'HUMAN_HANDOFF'};
    }
    await this.orders.loadMenu();
    const menu=this.assistantMenu();
    // An exact catalog selection can enter ordering directly.
    const selection=normalizeText(message.text).replace(/[.!]+$/g,'').trim();
    if(menu.some(item=>[item.name,...item.aliases].some(name=>normalizeText(name)===selection)))return routeToOrder();
    const explicitCoverage=coverageQuestionReply(message.text);
    if(explicitCoverage&&asksGenericDelivery(message.text)){await this.sendCoverageMap(phone,explicitCoverage);return {state:session.state,answered:true};}
    if(!this.cfg.NEW_ORDERS_PAUSED&&asksDeliveryAvailability(message.text)&&!asksPickup(message.text)&&!explicitCoverage){
      const all=await this.orders.availableWindows('delivery',true);
      const wanted=this.namedWindow(message.text,all);
      if(wanted&&wanted.remaining<=0)return this.showSoldOutOptions(phone,session,wanted.id);
      if(all.length&&!all.some(w=>w.remaining>0))return this.showSoldOutOptions(phone,session);
    }
    // A completed checkout resets the draft, but its payment terms still come
    // from the stored order, not the generic FAQ deposit policy.
    const paymentOrders=(await this.db.query<any>(`SELECT o.*,w.starts_at,w.ends_at,
      COALESCE((SELECT SUM(p.amount_cop)::int FROM payments p WHERE p.order_id=o.id AND p.status='confirmed'),0) AS paid_cop,
      (SELECT p.amount_cop FROM payments p WHERE p.order_id=o.id AND p.provider='manual_transfer' AND p.status='pending' ORDER BY p.created_at DESC LIMIT 1) AS transfer_due_cop
      FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
      WHERE c.phone_e164=$1 AND o.status IN ('confirmed','awaiting_payment','payment_review') AND (o.status='confirmed' OR o.payment_expires_at>now()) AND w.starts_at>now() ORDER BY o.created_at DESC`,[phone])).rows;
    const reference=message.text.match(/KC-[A-Z0-9]+/i)?.[0]?.toUpperCase();
    const pending=reference?paymentOrders.find(o=>o.public_id===reference):paymentOrders.length===1?paymentOrders[0]:undefined;
    let paymentReply='';
    if(pending){
      const full=pending.full_payment_required===true;
      const balance=Math.max(0,pending.total_cop-pending.paid_cop);
      paymentReply=`Pedido ${pending.public_id} · ${pending.status==='confirmed'?'confirmado':full?'pendiente de pago completo':'pendiente de pago'}.\nTotal: ${cop(pending.total_cop)}.\n\n`;
      if(pending.status==='confirmed')paymentReply+=`${pending.paid_cop>0?'Pago verificado: '+cop(pending.paid_cop)+'. ':''}`+(balance>0?'Saldo al recibir: '+cop(balance)+'.':'Tu pedido está pagado por completo.');
      else if(pending.transfer_due_cop)paymentReply+=(full?fullPaymentNotice:`Para confirmar tu pedido, transfiere el abono pendiente de ${cop(pending.transfer_due_cop)}.`)+`\n\n${full?fullPaymentInstructions(this.cfg.MANUAL_TRANSFER_INSTRUCTIONS):this.cfg.MANUAL_TRANSFER_INSTRUCTIONS}\nValor a transferir: ${cop(pending.transfer_due_cop)}\nReferencia: ${pending.public_id}\nEnvía el comprobante para que el equipo lo verifique.`;
      else paymentReply+='El equipo está revisando el pago. No hagas otra transferencia sin confirmar con el equipo.';
      if(pending.delivery_coverage?.needsReview)paymentReply+='\nEl equipo revisará la dirección; la confirmación final requiere verificar el pago y la cobertura.';
    }
    if(asksPaymentInformation(message.text)&&!reference&&paymentOrders.length>1){
      await this.messaging.sendNow(phone,'¿De cuál pedido quieres revisar el pago? Envíame su referencia KC-… para darte el valor correcto.','payment_question');
      return {state:session.state,answered:true};
    }
    if(pending&&asksPaymentInformation(message.text)){
      await this.messaging.sendNow(phone,paymentReply,'payment_question',pending.id);
      return {state:session.state,answered:true};
    }
    if(this.cfg.NEW_ORDERS_PAUSED&&!pending){
      if(explicitCoverage){await this.sendCoverageMap(phone,explicitCoverage);return {state:session.state,answered:true};}
      return this.sendOrderingPaused(phone);
    }
    const history=await this.recentHistory(message);
    let answer;
    let onlyPrepaid=false;
    try{
      if(message.text.length>6000)throw new Error('message too long');
      const schedule=await this.orders.availableWindows(asksPickup(message.text)?'pickup':'delivery',false,true);
      onlyPrepaid=this.cfg.NEW_ORDERS_FULL_PAYMENT||(schedule.length>0&&schedule.every(w=>w.prepayment_required));
      answer=await new GeneralAssistant(this.cfg).answer({message:message.text,history,now:new Date().toISOString(),timezone:this.cfg.BUSINESS_TIMEZONE,businessFacts,paymentPolicy:checkoutPaymentPolicy(pending?pending.full_payment_required===true:onlyPrepaid),orderButtonLabel:orderLabel,menu:generalMenuContext(menu,message.text),deliveryFeeCop:(await this.orders.quote([])).fee,referralBenefits:(await this.db.query("SELECT code,free_delivery FROM referral_codes WHERE active=TRUE AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now())")).rows,
        newOrderIntake:{paused:this.cfg.NEW_ORDERS_PAUSED,notice:this.cfg.NEW_ORDERS_PAUSED?orderingPauseReply(this.cfg):null},
        existingOrders:paymentOrders.map(o=>({reference:o.public_id,status:o.status,delivery:windowLabel(o.starts_at,o.ends_at,this.cfg.BUSINESS_TIMEZONE),paidCop:o.paid_cop,totalCop:o.total_cop})),
        deliverySchedule:schedule.map(w=>({delivery:windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE),remaining:w.remaining,prepayment_required:w.prepayment_required,pickup_available:w.pickup_available,ordersOpenAt:w.order_opens_at}))});
    }catch{
      const coverageReply=coverageQuestionReply(message.text);
      if(coverageReply){await this.sendCoverageMap(phone,coverageReply);return {state:session.state,answered:true};}
      await this.messaging.sendButtonsNow(phone,'Ahora no pude responder esa pregunta. Puedes volver a enviarla, tocar «Hablar con alguien» o elegir una opción del menú.',this.mainMenuButtons());
      await this.save(phone,{state:'MAIN_MENU',context:{}});return {state:'MAIN_MENU',aiUnavailable:true};
    }
    if(await isChatPaused(this.db,phone))return {mode:'staff_paused',replied:false};
    answer.reply=comboFirstReply(answer.reply,message.text,menu,orderLabel);
    const coverageReply=coverageQuestionReply(message.text,answer.coverageQuestion,history);
    if(coverageReply){
      await this.sendCoverageMap(phone,coverageReply);
      if(answer.action==='order')return routeToOrder();
      if(answer.action!=='handoff')return {state:session.state,answered:true};
    }
    if(!this.cfg.NEW_ORDERS_PAUSED&&answer.action!=='handoff'&&(asksDeliveryAvailability(message.text)||mentionsDeliverySchedule(answer.reply))){
      if(!asksPickup(message.text)){const current=await this.orders.availableWindows('delivery',true);if(current.length&&!current.some(w=>w.remaining>0))return this.showSoldOutOptions(phone,session);}
      answer.reply=availableDeliveryReply(message.text,await this.orders.availableWindows(asksPickup(message.text)?'pickup':'delivery',false,true) as any,this.cfg.BUSINESS_TIMEZONE);
      if(answer.action==='smalltalk')answer.action='answer';
    }
    if(pending?.full_payment_required&&contradictsFullPayment(answer.reply))answer.reply=paymentReply;
    else if(!pending&&onlyPrepaid&&contradictsFullPayment(answer.reply))answer.reply=advancePaymentReason+' '+fullPaymentNotice;
    if(answer.action==='order'&&pending&&this.cfg.NEW_ORDERS_PAUSED){
      await this.save(phone,{state:'HUMAN_HANDOFF',context:{}});
      await this.messaging.sendNow(phone,`Puedes dejar aquí los detalles del cambio que necesitas para tu pedido ${pending.public_id}; el equipo lo revisará contigo. Tu pedido conserva su estado actual.`, 'human_handoff',pending.id);
      return {state:'HUMAN_HANDOFF'};
    }
    if(answer.action==='order')return routeToOrder(answer.reply);
    if(answer.action==='handoff'){
      await this.save(phone,{state:'HUMAN_HANDOFF',context:{}});
      await this.messaging.sendNow(phone,'Puedes dejar tu pregunta aquí para el equipo. Para volver al menú, escribe MENÚ.','human_handoff');return {state:'HUMAN_HANDOFF'};
    }
    if(answer.action==='smalltalk')return session.state==='WELCOME'?this.showMainMenu(phone):{state:session.state,replied:false};
    await this.messaging.sendNow(phone,answer.reply.trim()||'No tengo ese dato confirmado. Puedes tocar «Hablar con alguien» para consultarlo con el equipo.','general_question');
    if(session.state==='WELCOME')return this.showMainMenu(phone);
    await this.save(phone,{state:'MAIN_MENU',context:{}});return {state:'MAIN_MENU',answered:true};
  }

  private async naturalOrder(message:InboundMessage,session:Session) {
    if(this.cfg.NEW_ORDERS_PAUSED)return this.sendOrderingPaused(message.phone);
    const phone=message.phone;
    if(!session.context.orderingOptIn)return {state:session.state,replied:false};
    // Ingredient descriptions are not allergen certifications. Pause ordering for staff review.
    if(/\b(?:alerg\w*|allerg\w*)/i.test(normalizeText(message.text))){
      await this.save(phone,{state:'HUMAN_HANDOFF',context:session.context});
      await this.messaging.sendNow(phone,'Para una alergia necesitamos que el equipo revise los ingredientes y la preparación. No puedo asegurar que un producto sea apto. Dejé el pedido pausado; puedes dejar aquí los detalles de tu alergia.','human_handoff');
      return {state:'HUMAN_HANDOFF'};
    }
    await this.orders.loadMenu();
    const menu=this.orders.menu();
    let windows=await this.orderingWindows(session.context);
    // Work on a copy. Failed interpretations must never partially change the cart.
    const context:ConversationContext=structuredClone(session.context);
    const barrioAsked=await barrioAlreadyAsked(this.db,phone);
    const awaitingBarrioReply=barrioAsked&&session.state==='ENTERING_ADDRESS'&&!!context.deliveryAddress&&coverageSnapshot(context.deliveryLocation??locationFromAddress(context.deliveryAddress),context.deliveryPreference).status==='unknown';
    const cart=context.cart??=[];
    const fullPaymentRequired=this.cfg.NEW_ORDERS_FULL_PAYMENT||!!context.fullPrepayment||!!windows.find(w=>w.id===context.windowId)?.prepayment_required||(windows.length>0&&windows.every(w=>w.prepayment_required));
    if(this.cfg.NEW_ORDERS_FULL_PAYMENT)context.fullPrepayment=true;
    if(context.pendingSelection) {
      const p=context.pendingSelection;
      for(const id of p.menuItemIds)this.addToCart(cart,id,{sauce:p.sauce,spice:p.spice},p.quantities?.[id]??1);
      delete context.pendingSelection;
    }
    if(context.orderingOptIn&&context.menuVersion!==undefined&&context.menuVersion!==this.orders.menuVersion()) {
      const changed=refreshWholePieceDraft(context,menu);
      if(changed.length){
        context.menuVersion=this.orders.menuVersion();context.menuSignature=this.menuSignature();
        await this.save(phone,{state:'CHOOSING_ITEM',context});
        await this.messaging.sendNow(phone,crabExplanation(changed[0]!));
        return {state:'CHOOSING_ITEM',portionConfirmation:true};
      }
    }
    if(context.orderingOptIn&&context.menuVersion!==undefined&&context.menuSignature&&context.menuSignature!==this.menuSignature()) {
      const available=cart.filter(l=>menu.some(i=>i.id===l.menuItemId)),removed=available.length!==cart.length;
      cart.splice(0,cart.length,...available);
      context.pendingCrabPortions=context.pendingCrabPortions?.filter(e=>menu.some(i=>i.id===e.itemId));
      context.menuVersion=this.orders.menuVersion();context.menuSignature=this.menuSignature();
      await this.save(phone,{state:removed?'CHOOSING_ITEM':session.state,context});
      if(removed){await this.messaging.sendNow(phone,'Uno de los productos que elegiste no está disponible. ¿Qué te gustaría pedir en su lugar?');return {state:'CHOOSING_ITEM',menuChanged:true};}
      // Catalog publication is internal. Continue interpreting the same customer
      // message with the available products; never announce a menu update.

    }
    const allWindows=await this.orderingWindows(context,true);
    const requested=this.namedWindow(message.text,allWindows);
    const history=await this.recentHistory(message);
    let plan:Interpretation;
    const shortReply=normalizeText(message.text).replace(/[.!]+$/,'').trim();
    const numberedId=session.state==='CHOOSING_WINDOW'&&/^\d{1,2}$/.test(shortReply)
      ? context.offeredWindowIds?.[Number(shortReply)-1] : undefined;
    const numberedWindow=numberedId?windows.find(w=>w.id===numberedId&&windowAvailable(w)):undefined;
    const pickupReply=/^(?:(?:yo )?(?:prefiero|quiero|voy a|lo voy a) )?(?:recoger|recogida|recojo|pickup)(?: (?:porfa|por favor))?$/.test(shortReply);
    try{
      if(message.text.length>6000)throw new Error('message too long');
      // Explicit replies to our own choices do not need another model interpretation.
      if(numberedWindow||pickupReply){
        plan={intent:'continue',edits:[],coverageQuestion:null,deliveryLocation:null,
          deliveryPreference:pickupReply?{choice:'pickup',evidence:message.text}:null,
          windowId:numberedWindow?.id??null,windowEvidence:numberedWindow?message.text:null,
          address:null,referralCode:null,clearReferral:false,skipExtras:false,holdOrder:false,orderReference:null,reply:''};
      }else plan=await new OrderAssistant(this.cfg).interpret({
        now:new Date().toISOString(),timezone:this.cfg.BUSINESS_TIMEZONE,state:session.state,orderingActive:!!context.orderingOptIn,
        message:message.text,history,
        menu:this.assistantMenu(),pendingCrabPortions:context.pendingCrabPortions??[],
        cart:cart.map((l,i)=>({...l,lineId:`line-${i}`,name:menu.find(m=>m.id===l.menuItemId)?.name})),
        savedDetails:{windowId:context.windowId??null,deliveryPreference:context.deliveryPreference??null,address:context.deliveryAddress??null,deliveryLocation:context.deliveryLocation??null,coverage:context.deliveryLocation?await this.orders.coverage(context.deliveryLocation,context.deliveryPreference):null,barrioAlreadyAsked:barrioAsked,referralCode:context.referralCode??null,pendingReferralCode:context.pendingReferralCode??null,extrasAlreadyOffered:!!context.aiExtrasHandled||!!context.checkoutExtrasPending||!!context.checkoutExtrasHandled,checkoutExtrasPending:!!context.checkoutExtrasPending,extrasDeclined:!!context.extrasDeclined,deliveryContactPhones:context.deliveryContactPhones??[],deliverySingleContactAccepted:!!context.deliverySingleContactAccepted,awaitingDeliveryContacts:!!context.awaitingDeliveryContacts},
        pickupWindows:(asksPickup(message.text)||bookingType(context.deliveryPreference)==='pickup'?await this.orders.availableWindows('pickup'):[]).map(w=>({id:w.id,pickup:windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE),pickup_available:true})),
        windows:windows.map(w=>({id:w.id,number:context.offeredWindowIds?context.offeredWindowIds.indexOf(w.id)+1:windows.indexOf(w)+1,delivery:windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE),remaining:w.remaining,prepayment_required:w.prepayment_required,pickup_available:w.pickup_available,cutoff:w.order_cutoff_at})),
        policies:{...checkoutPaymentPolicy(fullPaymentRequired),deliveryFeeCop:(await this.orders.quote([])).fee,quote:await this.orders.quote(cart,context.referralCode,context.deliveryPreference),referralBenefits:(await this.db.query("SELECT code,free_delivery FROM referral_codes WHERE active=TRUE AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now())")).rows,deliveryArea:businessFacts.deliveryArea,deliveryCoverage:deliveryCoveragePolicy,paymentVerification:'manual by staff; never confirm receipt of payment',businessInstructions:this.copy('ordering_intro',{schedule:'Ver franjas disponibles', 'cupos-disponibles':deliveryAvailability(windows as any,this.cfg.BUSINESS_TIMEZONE),'proxima-franja':'Ver franjas disponibles'})}
      });
    }catch{
      if(this.cfg.FAST_CHECKOUT_ENABLED){
        plan={intent:'continue',edits:[],deliveryLocation:null,deliveryPreference:null,windowId:null,address:null,referralCode:null,clearReferral:false,skipExtras:true,holdOrder:false,orderReference:null,reply:'',reviewNotes:['Interpretación pendiente: '+message.text]};
      }else{
      const coverageReply=coverageQuestionReply(message.text);
      if(coverageReply){await this.sendCoverageMap(phone,coverageReply);return {state:session.state,answered:true};}
      await this.messaging.sendButtonsNow(phone,'Ahora no pude entender bien tu mensaje. Tu pedido sigue guardado. Puedes volver a enviarlo o pedir ayuda al equipo.',[{id:'kc:human',title:'Hablar con alguien'}]);
      return {state:session.state,aiUnavailable:true};
      }
    }
    if(await isChatPaused(this.db,phone))return {mode:'staff_paused',replied:false};
    // AI calls can take seconds: recheck seats and cutoffs before offering or accepting a slot.
    const statedPreference=plan.deliveryPreference&&normalizeText(message.text).includes(normalizeText(plan.deliveryPreference.evidence))?plan.deliveryPreference.choice:context.deliveryPreference;
    windows=await this.orderingWindows({...context,deliveryPreference:statedPreference});
    const statedDestination=destinationStatement(message.text);
    const statedAddress=literalAddress(message.text);
    if(this.cfg.FAST_CHECKOUT_ENABLED&&plan.intent==='handoff'&&!/\b(humano|persona|asesor|alguien|equipo|human|person)\b/.test(normalizeText(message.text))){plan={...plan,intent:'continue',reviewNotes:[...(plan.reviewNotes??[]),'Solicitud por revisar: '+message.text]};}
    if(this.cfg.FAST_CHECKOUT_ENABLED&&(['order','continue','clarify'].includes(plan.intent)||asksPaymentInformation(message.text)&&!!cart.length)){
      return this.fastOrder(message,session,context,plan,windows,requested,statedAddress,statedDestination);
    }
    const statedSpice=normalizeText(message.text).replace(/[.!]+$/,'').match(/^(?:(?:lo|los) quiero (?:con )?|con )?(?:picante )?(suave|medio)(?: (?:por favor|porfa|todos))?$/)?.[1];
    // Short factual replies must not be lost when the model returns an empty edit
    // list or wrongly classifies them as a coverage question.
    if(statedSpice&&cart.some(l=>!l.customization?.spice)){
      plan={...plan,intent:'continue',coverageQuestion:null,reply:'',address:null,deliveryLocation:null,deliveryPreference:null,windowId:null,referralCode:null,clearReferral:false,
        edits:cart.flatMap((l,i)=>menu.find(m=>m.id===l.menuItemId)?.category==='plate'&&!l.customization?.spice?[{operation:'set' as const,itemId:l.menuItemId,lineId:`line-${i}`,quantity:null,spice:statedSpice==='suave'?'Suave' as const:'Medio' as const,sauce:null}]:[])};
    }else if(statedDestination||statedAddress){
      plan={...plan,intent:'continue',coverageQuestion:null,reply:'',edits:[],windowId:null,referralCode:null,clearReferral:false,deliveryPreference:null,
        address:statedAddress,deliveryLocation:statedDestination??(plan.deliveryLocation&&literalLocation(plan.deliveryLocation,message.text)?plan.deliveryLocation:null)};
    }
    const coverageReply=coverageQuestionReply(message.text,plan.coverageQuestion,history);
    if(coverageReply&&awaitingBarrioReply&&asksBarrioName(coverageReply)){
      plan={...plan,intent:'continue',reply:'',coverageQuestion:null};
    }else if(coverageReply){
      await this.sendCoverageMap(phone,coverageReply);
      plan.reply='';
      if(['question','clarify','smalltalk'].includes(plan.intent))return {state:session.state,answered:true};
    }
    if(plan.intent==='handoff'){
      await this.save(phone,{state:'HUMAN_HANDOFF',context:session.context});
      await this.messaging.sendNow(phone,this.copy('human_handoff'),'human_handoff');return {state:'HUMAN_HANDOFF'};
    }
    if(plan.intent==='menu'){
      await this.sendMenuOverview(phone);return {state:session.state};
    }
    if(plan.intent==='cancel_draft')return this.showMainMenu(phone);
    if(plan.intent==='cancel_order'||plan.intent==='order_status'){
      const order=plan.orderReference?await this.orders.orderByPublicId(plan.orderReference):null;
      if(!order||order.phone_e164!==phone){await this.messaging.sendNow(phone,'Pásame la referencia del pedido que te enviamos (KC-…). Así puedo revisar el pedido de este número.');return {state:session.state};}
      if(plan.intent==='cancel_order'){
        try{
          const cancelled=await this.orders.cancel(order.public_id,phone);
          if(cancelled.cancellationPending){await this.messaging.sendNow(phone,'Recibimos tu solicitud. La cancelación todavía necesita confirmación de cocina.','cancellation_requested',order.id);return {state:session.state};}
          await this.messaging.sendNow(phone,this.copy('cancelled',{reference:cancelled.public_id,refund:cancelled.paid?' El equipo debe gestionar el reembolso; todavía no se ha enviado.':''}),'cancellation',order.id);
        }catch{await this.messaging.sendNow(phone,this.cfg.POS_RUNTIME_ENABLED?'No pude registrar la cancelación. El equipo puede ayudarte a revisar el estado del pedido.':'No pude cancelar ese pedido automáticamente. La cancelación debe hacerse al menos 12 horas antes de la entrega; el equipo puede ayudarte a revisarlo.');}
      }else{
        const labels:Record<string,string>={awaiting_payment:'Pendiente del pago y su verificación por el equipo',confirmed:'Confirmado para preparar',cancelled:'Cancelado',expired:'Reserva vencida',payment_review:'Pago en revisión',fulfilled:'Entregado'};
        await this.messaging.sendNow(phone,this.copy('status',{reference:order.public_id,status:(labels[order.status]??'En revisión')+(order.delivery_coverage?.needsReview?' · entrega pendiente de coordinación por el equipo':''),total:cop(order.total_cop)}),'order_status',order.id);
      }
      return {state:session.state};
    }
    // One unanswered barrio clarification is enough. Payment questions and
    // unrecognized replies must advance the saved order to team review.
    if(awaitingBarrioReply&&['question','clarify','smalltalk'].includes(plan.intent))plan={...plan,intent:'continue',reply:''};
    if(awaitingBarrioReply&&plan.deliveryLocation&&!literalLocation(plan.deliveryLocation,message.text))plan.deliveryLocation=null;
    const fullPaymentQuestion=fullPaymentRequired&&['question','clarify'].includes(plan.intent)&&asksPaymentInformation(message.text);
    if(fullPaymentRequired&&(fullPaymentQuestion||contradictsFullPayment(plan.reply))){
      plan.reply=['question','clarify','smalltalk'].includes(plan.intent)
        ? advancePaymentReason+' Al completar los datos de tu pedido, te envío el total y la cuenta bancaria para transferir.' : '';
    }
    if(!fullPaymentQuestion&&(mentionsDeliverySchedule(plan.reply)||['question','clarify','smalltalk'].includes(plan.intent)&&asksDeliveryAvailability(message.text))){
      plan.reply=availableDeliveryReply(message.text,windows as any,this.cfg.BUSINESS_TIMEZONE);
    }
    if(['order','continue'].includes(plan.intent)&&needsPersonalChoice(message.text,cart,menu,history)){
      plan={...plan,intent:'clarify',edits:[],reply:'¿Tu Personal lo prefieres original con 2 patas de nieve y langostino, con mejillones, o con doble langostino? Los tres cuestan $85.000.'};
    }
    if(this.cfg.STANDARD_SPICE&&plan.edits.some(e=>e.spice&&e.spice!==this.cfg.STANDARD_SPICE)){
      plan={...plan,intent:'clarify',edits:[],reply:standardSpiceNotice(this.cfg.STANDARD_SPICE)+' ¿Te sirve así?'};
    }
    let crabNotices:string[]=[];
    if(['order','continue'].includes(plan.intent)||context.pendingCrabPortions?.length&&['clarify','question'].includes(plan.intent)){
      const prepared=prepareCrabEdits(message.text,plan,context,menu);plan=prepared.plan;crabNotices=prepared.notices;
    }
    if(!['order','continue'].includes(plan.intent)){
      if(requested&&requested.remaining<=0&&!context.fullPrepayment&&!asksPickup(message.text)&&bookingType(context.deliveryPreference)==='delivery')return this.showSoldOutOptions(phone,session,requested.id);
      if(plan.intent==='smalltalk'&&!context.orderingOptIn)return session.state==='WELCOME'?this.showMainMenu(phone):{state:session.state,replied:false};
      await this.messaging.sendNow(phone,plan.reply.trim()||'¿Me cuentas un poco más para ayudarte?');
      if(context.orderingOptIn)await this.save(phone,session);
      return {state:session.state};
    }
    if(!context.orderingOptIn&&plan.intent!=='order'){
      await this.messaging.sendNow(phone,'¿Quieres hacer un pedido nuevo o consultar uno que ya hiciste?');return {state:session.state};
    }
    let referralNotice='';
    try{
      context.cart=withStandardSpice(applyCartEdits(cart,plan.edits,menu,this.linkedMenu()),menu,this.cfg.STANDARD_SPICE);
      if(plan.address!==null){
        const address=plan.address.trim();
        if(address.length<8||!/[0-9]/.test(address)||/[?¿]/.test(address)||!normalizeText(message.text).includes(normalizeText(address)))throw new DraftClarification('¿Me pasas la dirección completa, con número y los detalles para encontrarte?');
        if(address!==context.deliveryAddress){
          const extracted=locationFromAddress(address),prior=context.deliveryLocation;
          const changed=!!context.deliveryAddress||!!(extracted.municipality&&prior?.municipality&&normalizeText(extracted.municipality)!==normalizeText(prior.municipality))||!!(extracted.area&&prior?.area&&normalizeText(extracted.area)!==normalizeText(prior.area));
          context.deliveryLocation=changed?extracted:{municipality:extracted.municipality??prior?.municipality??null,area:extracted.area??prior?.area??null};
          if(changed){delete context.deliveryPreference;delete context.coveragePromptKey;}
        }
        context.deliveryAddress=address;
      }
      if(plan.deliveryLocation){
        if(!literalLocation(plan.deliveryLocation,message.text))throw new DraftClarification('No pude verificar ese cambio de ubicación. Conservé los datos que ya nos diste.');
        const previous=context.deliveryLocation;
        // A new municipality invalidates a previously saved neighborhood. An
        // area-only clarification can retain the previously supplied municipality.
        const location={municipality:plan.deliveryLocation.municipality??previous?.municipality??null,area:plan.deliveryLocation.area??(plan.deliveryLocation.municipality&&normalizeText(plan.deliveryLocation.municipality)!==normalizeText(previous?.municipality??'')?null:previous?.area??null)};
        if(JSON.stringify(location)!==JSON.stringify(previous)){delete context.deliveryPreference;delete context.coveragePromptKey;}
        context.deliveryLocation=location;
      }
      if(plan.deliveryPreference){
        const literal=normalizeText(message.text).includes(normalizeText(plan.deliveryPreference.evidence));
        // The model may restate a choice already saved from an earlier message.
        // That is not a new change and must not invalidate a date reply.
        if(!literal&&plan.deliveryPreference.choice!==context.deliveryPreference)throw new DraftClarification('¿Prefieres recogida, enviar tu mensajero o que el equipo revise la entrega?');
        if(literal)context.deliveryPreference=plan.deliveryPreference.choice;
      }
      windows=await this.orderingWindows(context);
      if(bookingType(context.deliveryPreference)==='delivery'&&!asksPickup(message.text)&&requested&&requested.remaining<=0&&(!context.fullPrepayment||!windows.some(w=>w.id===requested.id)))return this.showSoldOutOptions(phone,{state:session.state,context},requested.id);
      if(plan.windowId&&!hasWindowChoiceEvidence(message.text,plan.windowEvidence))plan.windowId=null;
      // A requested weekday is sufficient when it has exactly one public window.
      // Do not infer from a question, a negation, or a conflicting explicit day number.
      if(!plan.windowId&&requested&&!/[?¿]/.test(message.text)&&! /\b(?:no|otro|otra)\b/.test(normalizeText(message.text))){
        const dayNumber=normalizeText(message.text).match(/\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?:el\s+)?(\d{1,2})\b/)?.[1];
        if(!dayNumber||Number(dayNumber)===DateTime.fromISO(requested.starts_at).setZone(this.cfg.BUSINESS_TIMEZONE).day){plan.windowId=requested.id;plan.windowEvidence=message.text;}
      }
      if(plan.windowId){
        const window=windows.find(w=>w.id===plan.windowId&&windowAvailable(w));
        if(!window)throw new DraftClarification('Esa franja ya no tiene cupos. Estas son las opciones actuales:\n'+deliveryAvailability(windows as any,this.cfg.BUSINESS_TIMEZONE));
        context.windowId=window.id;
        if(window.prepayment_required&&!context.fullPrepayment){
          await this.save(phone,{state:'CHOOSING_WINDOW',context});
          return this.showSoldOutOptions(phone,{state:'CHOOSING_WINDOW',context},window.id);
        }
      }
      if(plan.clearReferral){delete context.referralCode;delete context.pendingReferralCode;}
      if(plan.referralCode){
        const active=(await this.db.query<{code:string;free_delivery:boolean}>(`SELECT code,free_delivery FROM referral_codes WHERE active=TRUE AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now())`)).rows;
        const matches=active.filter(code=>normalizeText(code.code)===normalizeText(plan.referralCode!));
        const found=matches.length===1?matches[0]:undefined;
        if(!found){context.pendingReferralCode=plan.referralCode;referralNotice='No encontré ese código activo. Conservé los datos de tu pedido; puedes corregir el código o decir «sin código».';}
        else {context.referralCode=found.code;delete context.pendingReferralCode;referralNotice=found.free_delivery?`Código ${found.code} aplicado: tu domicilio es gratis.`:`Código ${found.code} aplicado.`;}
      }
    }catch(error){
      if(!(error instanceof DraftClarification))throw error;
      await this.messaging.sendNow(phone,error.message);return {state:session.state,clarification:true};
    }
    const starting=!context.orderingOptIn;
    context.orderingOptIn=true;context.fulfillmentType='delivery';context.menuVersion=this.orders.menuVersion();context.menuSignature=this.menuSignature();
    if(plan.skipExtras||plan.windowId||plan.address)context.aiExtrasHandled=true;
    // The model can understand refusals beyond the deterministic short replies.
    // Persist that decision at checkout, rather than only hiding the earlier hint.
    if(context.checkoutExtrasPending&&plan.skipExtras){
      context.checkoutExtrasHandled=true;context.extrasDeclined=true;
      delete context.checkoutExtrasPending;
    }
    if(starting)await this.messaging.sendNow(phone,this.copy(this.cfg.AI_ORDERING_ENABLED&&this.cashOnDelivery()?'ordering_intro':'welcome',{schedule:deliveryAvailability(windows as any,this.cfg.BUSINESS_TIMEZONE),'cupos-disponibles':deliveryAvailability(windows as any,this.cfg.BUSINESS_TIMEZONE),'proxima-franja':windows.length?windowLabel(windows[0]!.starts_at,windows[0]!.ends_at,this.cfg.BUSINESS_TIMEZONE):'por confirmar'}));
    const updated:Session={state:'CHOOSING_ITEM',context};
    const selected=context.cart??[];
    const coverage=await this.orders.coverage(context.deliveryLocation??locationFromAddress(context.deliveryAddress??''),context.deliveryPreference);
    const coverageKey=JSON.stringify([context.deliveryAddress,context.deliveryLocation,coverage.status]);
    let coverageNotice='';
    if(coverage.status==='unknown'&&!context.deliveryPreference&&context.deliveryAddress&&(barrioAsked||context.deliveryLocation?.area)){
      context.deliveryPreference='review';context.coveragePromptKey=coverageKey;coverageNotice=barrioReviewNotice;
    }
    if(coverage.needsReview&&context.deliveryPreference&&context.coveragePromptKey!==coverageKey){
      context.coveragePromptKey=coverageKey;
      coverageNotice=context.deliveryPreference==='pickup'?pickupLocationNotice:context.deliveryPreference==='own_courier'?'Dejé indicado que quieres enviar tu mensajero. '+pickupLocationNotice:'Seguimos con revisión de la entrega por el equipo, sin prometer cobertura.';
    }
    let nextQuestion='';
    if(context.pendingCrabPortions?.length){
      const pending=context.pendingCrabPortions[0]!;
      nextQuestion=crabExplanation(menu.find(i=>i.id===pending.itemId)!);
    }
    else if(!context.deliveryPreference&&coverage.status==='outside'){
      updated.state='ENTERING_ADDRESS';context.coveragePromptKey=coverageKey;nextQuestion=coverageWarning(coverage,!!context.deliveryLocation?.area);
    }
    else if(!this.cartHasPlate(selected))nextQuestion='¿Qué combo o mariscos te gustaría pedir?';
    else{
      const missing=selected.filter(l=>menu.find(i=>i.id===l.menuItemId)?.category==='plate'&&!l.customization?.spice);
      if(missing.length){updated.state='CHOOSING_SPICE';nextQuestion=`¿Los quieres con picante suave o medio? (${[...new Set(missing.map(l=>menu.find(i=>i.id===l.menuItemId)!.name))].join(', ')})`;}
      else if(!context.windowId||!windows.some(w=>w.id===context.windowId&&windowAvailable(w))){
        delete context.windowId;updated.state='CHOOSING_WINDOW';context.offeredWindowIds=windows.filter(windowAvailable).map(w=>w.id);
        nextQuestion='¿Qué fecha y horario te sirven?\n'+windows.filter(windowAvailable).map((w,i)=>`${i+1}. ${windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE)} · ${w.pickup_available?'recogida disponible':w.prepayment_required?'solo con pago completo por transferencia':`${w.remaining} cupos de domicilio`}`).join('\n');
        if(!context.offeredWindowIds.length&&bookingType(context.deliveryPreference)==='delivery')return this.showSoldOutOptions(phone,updated);
        if(!context.offeredWindowIds.length)nextQuestion='Por ahora no quedan franjas abiertas.';
        else if(!context.aiExtrasHandled&&this.step('upsell')){
          context.aiExtrasHandled=true;
          nextQuestion+='\n\nSi quieres extras, puedes incluirlos en la misma respuesta.';
        }
      }else if(!context.deliveryAddress&&!['pickup','own_courier'].includes(context.deliveryPreference??'')){updated.state='ENTERING_ADDRESS';nextQuestion='¿A qué dirección lo llevamos? Incluye el número y los detalles de acceso.';}
      else if(coverage.status==='unknown'&&!context.deliveryPreference){updated.state='ENTERING_ADDRESS';context.coveragePromptKey=coverageKey;nextQuestion=coverageWarning(coverage,!!context.deliveryLocation?.area);}
      else if(context.pendingReferralCode){updated.state='REVIEWING';nextQuestion='Ya tengo los datos de tu pedido. Solo falta corregir el código o decir «sin código» para registrarlo.';}
      else if(!plan.holdOrder){
        await this.save(phone,updated);
        if(coverageNotice)await this.messaging.sendNow(phone,coverageNotice);
        try{return await this.completeCashOnDelivery(phone,updated);}catch(error){
          // If the order committed but its final send failed, its atomic session reset
          // must be preserved. Never restore the draft or create a duplicate order.
          const persisted=await this.load(phone);
          if(!persisted.context.orderingOptIn)throw error;
          if(error instanceof Error&&/Solo quedan|Confirma el resumen|receta/.test(error.message)){await this.messaging.sendNow(phone,error.message);return {state:updated.state,clarification:true};}
          delete context.windowId;updated.state='CHOOSING_WINDOW';await this.save(phone,updated);
          return this.showSoldOutOptions(phone,updated);
        }
      }else {updated.state='REVIEWING';nextQuestion='Dejé tu selección guardada sin registrar. Dime qué quieres ajustar o cuándo seguimos.';}
    }
    await this.save(phone,updated);
    const summary=plan.edits.length?'Tu pedido va así:\n'+selected.map(l=>`• ${saleLineLabel(menu.find(i=>i.id===l.menuItemId)!.name,l.quantity,l.customization)}${l.customization?.spice?' · '+l.customization.spice:''}`).join('\n')+(selected.length?'\nTotal'+(selected.some(l=>l.customization?.finalWeightPending)?' estimado':'')+': '+cop((await this.orders.quote(selected,context.referralCode,context.deliveryPreference)).total):'\nTodavía no hay productos seleccionados.')+'\n\n':'';
    const safeReply=!asksPickup(message.text)&&bookingType(context.deliveryPreference)==='delivery'&&/recog|pickup|mensajero propio/i.test(plan.reply)?'':plan.reply.trim();
    await this.messaging.sendNow(phone,[referralNotice,coverageNotice,...crabNotices,safeReply,summary+nextQuestion].filter(Boolean).join('\n\n'));
    return {state:updated.state};
  }

  private async fastOrder(message:InboundMessage,session:Session,context:ConversationContext,plan:Interpretation,windows:any[],requested:any,statedAddress:string|null,statedDestination:any){
    const phone=message.phone,menu=this.orders.menu();
    fastCheckoutCart(message,plan,context,menu,this.linkedMenu(),this.cfg.STANDARD_SPICE||'Suave');
    const literal=(value:string)=>normalizeText(message.text).includes(normalizeText(value));
    const address=statedAddress??plan.address;
    if(address&&literal(address)&&address.trim().length>=3&&!/[?¿]/.test(address)){
      if(context.deliveryAddress&&context.deliveryAddress!==address){delete context.deliveryLocation;delete context.deliveryPreference;}
      context.deliveryAddress=address.trim();
      if(!/\d/.test(address))flagCheckout(context,'Dirección parcial: falta número o referencia exacta.');
    }else if(address)flagCheckout(context,'Dirección interpretada no verificable; conservar los datos literales del chat.');
    const location=statedDestination??plan.deliveryLocation;
    if(location&&literalLocation(location,message.text))context.deliveryLocation={municipality:location.municipality??context.deliveryLocation?.municipality??null,area:location.area??context.deliveryLocation?.area??null};
    if(plan.deliveryPreference&&literal(plan.deliveryPreference.evidence))context.deliveryPreference=plan.deliveryPreference.choice;
    windows=await this.orderingWindows(context);
    let windowId=plan.windowId&&hasWindowChoiceEvidence(message.text,plan.windowEvidence)?plan.windowId:null;
    if(!windowId&&requested&&!/[?¿]/.test(message.text)&&! /\b(no|otro|otra)\b/.test(normalizeText(message.text))){
      const day=normalizeText(message.text).match(/\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?:el\s+)?(\d{1,2})\b/)?.[1];
      if(!day||Number(day)===DateTime.fromISO(requested.starts_at).setZone(this.cfg.BUSINESS_TIMEZONE).day)windowId=requested.id;
    }
    if(windowId){
      if(windows.some(w=>w.id===windowId&&windowAvailable(w)))context.windowId=windowId;
      else {delete context.windowId;flagCheckout(context,'Fecha solicitada sin cupos: requiere elegir otra franja disponible.');}
    }
    if(plan.clearReferral){delete context.referralCode;delete context.pendingReferralCode;}
    if(plan.referralCode){
      const code=(await this.db.query<{code:string}>("SELECT code FROM referral_codes WHERE lower(code)=lower($1) AND active=TRUE AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now())",[plan.referralCode])).rows[0];
      if(code)context.referralCode=code.code;
      else flagCheckout(context,`Código ${plan.referralCode} pendiente de validar; total sin ese descuento.`);
    }
    if(context.pendingReferralCode){flagCheckout(context,`Código ${context.pendingReferralCode} pendiente de validar; total sin ese descuento.`);delete context.pendingReferralCode;}
    context.orderingOptIn=true;context.fullPrepayment=true;context.fulfillmentType='delivery';context.menuVersion=this.orders.menuVersion();context.menuSignature=this.menuSignature();
    context.aiExtrasHandled=true;context.checkoutExtrasHandled=true;delete context.checkoutExtrasPending;delete context.awaitingDeliveryContacts;
    const updated:Session={state:'CHOOSING_ITEM',context};
    const missing:string[]=[];
    if(!this.cartHasPlate(context.cart??[]))missing.push('qué combo o mariscos quieres y cuántos');
    if(!windows.some(w=>w.id===context.windowId&&windowAvailable(w))){
      delete context.windowId;updated.state='CHOOSING_WINDOW';context.offeredWindowIds=windows.filter(windowAvailable).map(w=>w.id);
      missing.push('la fecha de entrega');
    }
    if(!context.deliveryAddress&&!['pickup','own_courier'].includes(context.deliveryPreference??'')){updated.state='ENTERING_ADDRESS';missing.push('la dirección con número y apartamento o referencia');}
    if(missing.length){
      await this.save(phone,updated);
      const options=!context.windowId?'\n'+windows.filter(windowAvailable).map((w,i)=>`${i+1}. ${windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE)}`).join('\n'):'';
      if(!windows.length)return this.showSoldOutOptions(phone,updated);
      await this.messaging.sendNow(phone,'Para enviarte el total y los datos de pago, dime '+missing.join(' y ')+'.'+options);
      return {state:updated.state};
    }
    const coverage=await this.orders.coverage(context.deliveryLocation??locationFromAddress(context.deliveryAddress??''),context.deliveryPreference,context.windowId);
    if(coverage.needsReview){context.deliveryPreference='review';flagCheckout(context,'Dirección/cobertura por revisar; entrega aún no garantizada.');}
    if(plan.holdOrder&&/\b(espera|esperar|todavia no|aun no|no registres|no registrar|sigo agregando|seguir agregando)\b/.test(normalizeText(message.text))){
      updated.state='REVIEWING';await this.save(phone,updated);await this.messaging.sendNow(phone,'Tu selección queda guardada. Dime cuando quieras registrarla.');return {state:updated.state};
    }
    await this.save(phone,updated);
    try{return await this.completeCashOnDelivery(phone,updated);}
    catch(error){
      const persisted=await this.load(phone);if(!persisted.context.orderingOptIn)throw error;
      // Capacity, inventory and price validation stay authoritative.
      flagCheckout(context,'No se pudo finalizar automáticamente: '+(error instanceof Error?error.message:'requiere revisión'));
      await this.save(phone,updated);
      await this.messaging.sendNow(phone,'Guardé tu selección. El equipo debe revisar la disponibilidad antes de enviarte los datos de pago.','human_handoff');
      return {state:updated.state,needsReview:true};
    }
  }

  private async isReplyToBusinessMessage(phone:string){
    // A quoted reply can refer to an older message. Unquoted replies belong to
    // the current conversation when we have sent a message in the last 24h.
    // Read the claimed inbound event so every welcome entry point shares this
    // rule, including stale order buttons and AI routing.
    const result=await this.db.query(`SELECT 1 FROM message_outbox m JOIN customers c ON c.id=m.customer_id
      WHERE c.phone_e164=$1 AND m.status IN ('sent','sending') AND (
        COALESCE(m.sent_at,m.created_at)>now()-interval '24 hours' OR
        m.provider_message_id=(SELECT payload_json->>'replyToMessageId' FROM webhook_events
          WHERE provider='whatsapp' AND payload_json->>'phone'=$1 ORDER BY received_at DESC LIMIT 1)
      ) LIMIT 1`,[phone]);
    return result.rowCount>0;
  }

  private async sendIntakeWelcome(phone:string){
    if(await this.isReplyToBusinessMessage(phone))return false;
    const existing=(await this.db.query(`SELECT 1 FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone_e164=$1 AND o.status NOT IN ('cancelled','expired') LIMIT 1`,[phone])).rowCount;
    if(existing)return false;
    const recent=(await this.db.query(`SELECT 1 FROM message_outbox m JOIN customers c ON c.id=m.customer_id WHERE c.phone_e164=$1 AND m.kind='intake_welcome' AND m.status IN ('sent','sending') AND m.created_at>now()-interval '24 hours' LIMIT 1`,[phone])).rowCount;
    if(recent)return false;
    const windows=await this.orders.availableWindows('delivery',false,true);
    if(!windows.length)return false;
    const weekend=windows.every(w=>[6,7].includes(DateTime.fromISO(w.starts_at).setZone(this.cfg.BUSINESS_TIMEZONE).weekday));
    const when=weekend?'este fin de semana':'las fechas disponibles';
    await this.messaging.sendNow(phone,`¡Hola! 🦀💛 Por ahora tomamos pedidos para entregar ${when}. Por la alta demanda, pedimos el pago completo al crear tu pedido.\n\nCuéntanos qué te gustaría, para qué día y a qué dirección lo llevamos.`,'intake_welcome');
    return true;
  }

  private async showMainMenu(phone: string) {
    if(atCapacity(this.cfg)){
      const replied=await this.sendCapacityNotice(phone,true);
      return {state:'MAIN_MENU',replied};
    }
    const body=this.cfg.NEW_ORDERS_PAUSED?orderingPauseReply(this.cfg):this.copy('main_menu');
    await this.messaging.sendButtonsNow(phone, body, this.mainMenuButtons());
    await this.save(phone, { state: 'MAIN_MENU', context: {} });
    return { state: 'MAIN_MENU', replied: true };
  }

  private async sendOrderingPaused(phone:string) {
    if(atCapacity(this.cfg))return {mode:'capacity_closed',replied:await this.sendCapacityNotice(phone)};
    await this.messaging.sendNow(phone,orderingPauseReply(this.cfg),'ordering_paused');
    return {mode:'new_orders_paused',replied:true};
  }

  private mainMenuButtons() {
    const buttons=configuredMainMenuButtons(this.flow.getStore()!.messages);
    return grandOpening(this.cfg)?openingButtons(this.cfg):atCapacity(this.cfg)?capacityMenuButtons:buttons;
  }

  private async sendCapacityNotice(phone:string,force=false) {
    if(grandOpening(this.cfg)&&!force&&await this.isReplyToBusinessMessage(phone))return false;
    const recent=await this.db.query(`SELECT m.id FROM message_outbox m JOIN customers c ON c.id=m.customer_id
      WHERE c.phone_e164=$1 AND m.kind=$2 AND m.status='sent'
        AND m.buttons_json IS NOT NULL AND m.sent_at>now()-interval '24 hours' LIMIT 1`,[phone,grandOpening(this.cfg)?'grand_opening_notice':'capacity_notice']);
    if(recent.rowCount&&!force)return false;
    const result=await this.messaging.sendButtonsNow(phone,orderingPauseReply(this.cfg),grandOpening(this.cfg)?openingButtons(this.cfg):capacityMenuButtons,grandOpening(this.cfg)?'grand_opening_notice':'capacity_notice');
    const sent=!('suppressed' in result && result.suppressed);
    if(sent&&grandOpening(this.cfg))await this.messaging.sendImageNow(phone,this.responseImageUrl(responseImages.location),'📍 '+restaurantAddress+' Hay parqueadero al lado. '+openingNotice(),'grand_opening_location');
    return sent;
  }

  private async showExistingOrders(phone:string){
    const rows=(await this.db.query<any>(`SELECT o.id,o.public_id,o.status,o.total_cop,o.delivery_address,o.delivery_coverage,o.fulfillment_type,
      w.starts_at,w.ends_at,COALESCE((SELECT SUM(p.amount_cop) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed'),0)::int AS paid
      FROM orders o JOIN customers c ON c.id=o.customer_id JOIN delivery_windows w ON w.id=o.delivery_window_id
      WHERE c.phone_e164=$1 AND o.status NOT IN ('cancelled','expired') AND w.ends_at>now()-interval '1 day'
      ORDER BY w.starts_at LIMIT 5`,[phone])).rows;
    const labels:Record<string,string>={confirmed:'Confirmado',awaiting_payment:'Pendiente de pago o verificación',payment_review:'Pago en revisión',fulfilled:'Entregado'};
    const body=rows.length?rows.map(o=>`🦀 *${o.public_id} · ${o.delivery_coverage?.needsReview?'Entrega en revisión':labels[o.status]??o.status}*\n${['pickup','own_courier'].includes(o.delivery_coverage?.method??o.delivery_coverage?.preference??o.fulfillment_type)?'Pickup en El Poblado':'Entrega'}: ${windowLabel(o.starts_at,o.ends_at,this.cfg.BUSINESS_TIMEZONE)}\nTotal: ${cop(o.total_cop)}\nPagado: ${cop(o.paid)}\nSaldo pendiente: ${cop(Math.max(0,o.total_cop-o.paid))}`).join('\n\n')+'\n\nDéjanos tu consulta o los cambios que necesitas por aquí. El equipo te ayudará; no hace falta iniciar otro pedido.':
      'No veo un pedido activo asociado a este chat. Déjanos la referencia KC-… o el número con el que pediste y el equipo te ayudará. También puedes tocar «Hablar con alguien».';
    await this.messaging.sendNow(phone,body,'existing_order_support');
    // Do not erase a draft or payment context when a customer asks for help.
    const session=await this.load(phone);await this.save(phone,{...session,state:'HUMAN_HANDOFF'});
    return {existingOrders:rows.length};
  }

  private async prelaunch(message: InboundMessage) {
    // Commit the event only after a successful send (or a cooldown suppression).
    // A failed provider call rolls back so Meta can retry the webhook.
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query(`
        INSERT INTO webhook_events (id, provider, provider_event_id, payload_json, received_at, processed_at)
        VALUES ($1, 'whatsapp', $2, $3::jsonb, now(), now())
        ON CONFLICT(provider, provider_event_id) DO NOTHING RETURNING id
      `, [randomUUID(), message.eventId, JSON.stringify(message)]);
      if (!claimed.rowCount) return { duplicate: true };
      // The customer upsert also serializes concurrent messages from this phone.
      await tx.query(`
        INSERT INTO customers (id, phone_e164, display_name, locale, created_at, updated_at)
        VALUES ($1, $2, $3, 'es-CO', now(), now())
        ON CONFLICT(phone_e164) DO UPDATE SET
          display_name = COALESCE(excluded.display_name, customers.display_name), updated_at = now()
      `, [randomUUID(), message.phone, message.displayName ?? null]);
      const recent = await tx.query(`
        SELECT m.id FROM message_outbox m JOIN customers c ON c.id = m.customer_id
        WHERE c.phone_e164 = $1 AND m.kind = 'prelaunch_reply' AND m.status = 'sent'
          AND m.sent_at > $2 LIMIT 1
      `, [message.phone, new Date(Date.now() - this.cfg.PRELAUNCH_REPLY_COOLDOWN_HOURS * 3_600_000).toISOString()]);
      // A visitor starts a fresh menu conversation after opening, never an old draft cart.
      await tx.query(`DELETE FROM conversations WHERE phone_e164 = $1`, [message.phone]);
      if (recent.rowCount) return { mode: 'prelaunch' as const, replied: false };
      await this.messaging.withDb(tx).sendNow(message.phone, this.cfg.PRELAUNCH_REPLY, 'prelaunch_reply');
      return { mode: 'prelaunch' as const, replied: true };
    });
  }

  private responseImageUrl(path:string) {
    return this.cfg.WHATSAPP_PROVIDER==='demo'?path:`${this.cfg.PUBLIC_BASE_URL.replace(/\/$/,'')}${path}`;
  }
  private async sendCoverageMap(phone:string,reply:string,_menuTerms=false) {
    const body=[reply,'Domicilios solo sábados y domingos, de 6 a 10 p. m.: $15.000 dentro de la zona indicada. Recibimos pedidos para domicilios por este WhatsApp a partir del lunes 23 de noviembre. Fuera de la zona, puedes recoger en El Poblado o enviar tu propio domiciliario.',openingNotice()].filter(Boolean).join('\n\n');
    await this.messaging.sendImageNow(phone,this.responseImageUrl(responseImages.delivery),body,'delivery_coverage');
  }

  private orderingWindows(context:ConversationContext,includeFull=false) {
    const zone=specialDeliveryZone(context.deliveryLocation??locationFromAddress(context.deliveryAddress??''));
    return this.orders.availableWindows(bookingType(context.deliveryPreference),includeFull,true,zone);
  }
  private namedWindow(text:string,windows:Array<Record<string,any>>) {
    const value=normalizeText(text);
    const days=value.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g)??[];
    if(new Set(days).size!==1)return undefined;
    const matches=windows.filter(w=>normalizeText(DateTime.fromISO(w.starts_at).setZone(this.cfg.BUSINESS_TIMEZONE).setLocale('es').toFormat('cccc'))===days[0]);
    return matches.length===1?matches[0]:undefined;
  }
  private async showSoldOutOptions(phone:string,session:Session,windowId?:string) {
    if(this.cfg.NEW_ORDERS_PAUSED)return this.sendOrderingPaused(phone);
    const type=bookingType(session.context.deliveryPreference);
    const all=await this.orderingWindows(session.context,true);
    // An old button must not keep a now-closed Friday selected.
    const closedChoice=!!windowId&&!all.some(w=>w.id===windowId);
    if(closedChoice){delete session.context.windowId;delete session.context.soldOutWindowId;windowId=undefined;}
    const candidates=windowId?all.filter(w=>w.id===windowId):all.filter(w=>w.remaining<=0||w.date_full_payment_required);
    if(!candidates.length){
      if(!session.context.cart?.length)session={state:'MAIN_MENU',context:{}};
      else session.state='CHOOSING_WINDOW';
      await this.save(phone,session);
      await this.messaging.sendNow(phone,all.length?availableDeliveryReply('',all.filter(w=>w.remaining>0) as any,this.cfg.BUSINESS_TIMEZONE):'Por ahora no quedan franjas abiertas para pedidos. Consulta la próxima fecha con el equipo.');
      return {state:session.state,noAvailability:true};
    }
    session.state='SOLD_OUT_OPTIONS';
    session.context.soldOutWindowId=windowId;
    await this.save(phone,session);
    const available=(await this.orderingWindows(session.context)).filter(w=>candidates.some(c=>c.id===w.id));
    const prepay=available.some(w=>w.prepayment_required);
    const scope=windowId?windowLabel(candidates[0]!.starts_at,candidates[0]!.ends_at,this.cfg.BUSINESS_TIMEZONE):'estas fechas';
    const datePolicy=candidates.some(w=>w.date_full_payment_required);
    const body=(closedChoice?'Esa fecha ya está cerrada para nuevos pedidos.\n\n':'')+(datePolicy&&prepay
      ? `🦀 ${advancePaymentReason}\n\n*Entregas disponibles:*\n${deliveryAvailability(available as any,this.cfg.BUSINESS_TIMEZONE)}\n\nConfirmamos tu pedido al verificar el pago completo.`
      : `🦀 Los cupos regulares para ${scope} están llenos.`+(prepay?'\n\nPuedes garantizar tu pedido pagando el total por transferencia, sujeto a los cupos adicionales disponibles. Lo confirmamos al verificar el pago.':'\nTambién se agotaron los cupos adicionales con pago completo.'))+'\n\nTambién puedes entrar en la lista de espera. Si alguien cancela, te contactaremos para saber si todavía quieres hacer un pedido. Estar en la lista no reserva un cupo ni requiere pago.';
    await this.messaging.sendButtonsNow(phone,body,[...(prepay?[{id:'kc:prepay',title:'Pagar el total'}]:[]),{id:'kc:waitlist',title:'Lista de espera'}]);
    return {state:session.state,soldOut:true};
  }
  private async chooseWaitlistWindow(phone:string,session:Session) {
    const windows=await this.orderingWindows(session.context,true);
    const wanted=session.context.soldOutWindowId;
    // The sold-out prompt already identified a date/window explicitly chosen by the customer.
    if(wanted&&windows.some(w=>w.id===wanted))return this.saveWaitlist(phone,session,windows.find(w=>w.id===wanted)!);
    if(!windows.length){await this.messaging.sendNow(phone,'No hay franjas abiertas para la lista de espera. Puedes consultar la próxima entrega con el equipo.');return {state:session.state};}
    session.state='WAITLIST_WINDOW';session.context.offeredWindowIds=windows.map(w=>w.id);
    await this.save(phone,session);
    await this.messaging.sendNow(phone,'¿Para qué fecha y horario quieres entrar en la lista de espera?\n'+windows.map((w,i)=>`${i+1}. ${windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE)}`).join('\n'));
    return {state:session.state};
  }
  private async saveWaitlist(phone:string,session:Session,window:Record<string,any>) {
    await joinDeliveryWaitlist(this.db,{phone,windowId:window.id,draft:{cart:session.context.cart??[],deliveryAddress:session.context.deliveryAddress??null,deliveryZone:window.delivery_zone??null}});
    await this.save(phone,{state:'MAIN_MENU',context:{}});
    await this.messaging.sendNow(phone,`✅ Estás en la lista de espera para ${windowLabel(window.starts_at,window.ends_at,this.cfg.BUSINESS_TIMEZONE)}.\n\nSi alguien cancela, te contactaremos para saber si quieres hacer un pedido. No tienes un pedido confirmado ni necesitas pagar por estar en la lista.\n\nPara salir, escribe «salir de la lista».`,'waitlist_confirmation');
    return {state:'MAIN_MENU',waitlist:true};
  }
  private async handleSoldOutChoice(message:InboundMessage,session:Session) {
    const phone=message.phone,text=normalizeText(message.text);
    if(asksPickup(message.text)){
      session.state='CHOOSING_ITEM';session.context.orderingOptIn=true;session.context.deliveryPreference='pickup';
      delete session.context.soldOutWindowId;
      await this.save(phone,session);
      return this.cfg.AI_ORDERING_ENABLED?this.naturalOrder(message,session):this.showDeliveryWindows(phone,session);
    }
    if(session.state==='WAITLIST_WINDOW'){
      const windows=await this.orderingWindows(session.context,true);
      const index=/^\d+$/.test(text)?Number(text)-1:-1;
      const selected=index>=0?windows.find(w=>w.id===session.context.offeredWindowIds?.[index]):this.namedWindow(message.text,windows);
      if(selected)return this.saveWaitlist(phone,session,selected);
      return this.chooseWaitlistWindow(phone,session);
    }
    if(message.actionId==='kc:waitlist'||/^(?:2|lista de espera|(?:si |ok |bueno )?(?:quiero |anotame |entrar |en |a |la )*lista(?: de espera)?)(?: por favor| porfa)?$/.test(text))return this.chooseWaitlistWindow(phone,session);
    if(message.actionId==='kc:prepay'||choosesFullPayment(message.text)){
      const windows=await this.orderingWindows(session.context);
      const wanted=session.context.soldOutWindowId;
      const available=windows.filter(w=>(!wanted||w.id===wanted));
      if(!available.length)return this.showSoldOutOptions(phone,session,wanted);
      session.context.orderingOptIn=true;session.context.fullPrepayment=true;
      session.context.fulfillmentType='delivery';session.state='CHOOSING_ITEM';
      if(wanted)session.context.windowId=wanted;else delete session.context.windowId;
      const contacts=await knownDeliveryContactDetails(this.db,phone);
      session.context.deliveryContactPhones??=contacts.phones;
      session.context.deliverySingleContactAccepted??=contacts.singleAccepted;
      await this.orders.loadMenu();session.context.menuVersion=this.orders.menuVersion();session.context.menuSignature=this.menuSignature();
      await this.save(phone,session);
      await this.messaging.sendNow(phone,'Seguimos con pago completo por transferencia. El pedido queda confirmado cuando verifiquemos el pago.\n\nEntregas programadas para el fin de semana:\n'+deliveryAvailability(available as any,this.cfg.BUSINESS_TIMEZONE));
      if(!session.context.cart?.length){await this.sendFoodMenu(phone,true);await this.messaging.sendNow(phone,'¿Qué combo o mariscos te gustaría pedir?');return {state:session.state};}
      return this.cfg.AI_ORDERING_ENABLED?this.naturalOrder({...message,actionId:undefined,text:'Quiero continuar con los datos guardados de mi pedido.'},session):this.showDeliveryWindows(phone,session);
    }
    return this.showSoldOutOptions(phone,session,session.context.soldOutWindowId);
  }

  private async acceptOrderInvitation(message:InboundMessage){
    if(this.cfg.NEW_ORDERS_PAUSED)return null;
    if(!await pendingOrderInvitation(this.db,message))return null;
    await this.orders.loadMenu();
    const accepted=await this.db.transaction(async tx=>{
      await tx.query('SELECT customer_phone FROM whatsapp_chat_controls WHERE customer_phone=$1 FOR UPDATE',[message.phone]);
      const invitation=await pendingOrderInvitation(tx,message);
      if(!invitation)return null;
      await recordManualInvitation(tx,invitation);
      const claim=await tx.query(`UPDATE message_outbox SET order_invitation_json=order_invitation_json||$2::jsonb
        WHERE id=$1 AND order_invitation_json->>'acceptedEventId' IS NULL RETURNING id`,[invitation.id,JSON.stringify({acceptedEventId:message.eventId,acceptedAt:new Date().toISOString()})]);
      if(!claim.rowCount)return null;
      const existing=(await tx.query<any>(`SELECT o.public_id FROM orders o JOIN delivery_windows w ON w.id=o.delivery_window_id
        WHERE o.customer_id=$1 AND o.status IN ('confirmed','awaiting_payment','payment_review') AND w.ends_at>now()
          AND (o.status<>'awaiting_payment' OR o.payment_expires_at>now()) ORDER BY o.created_at DESC`,[invitation.customer_id])).rows;
      if(existing.length)return {existing,invitation,session:null};
      const saved=(await tx.query<any>('SELECT state,context_json FROM conversations WHERE phone_e164=$1 FOR UPDATE',[message.phone])).rows[0];
      const c:ConversationContext=structuredClone(saved?.context_json??{});
      c.orderingOptIn=true;c.fullPrepayment=true;c.fulfillmentType='delivery';c.orderInvitationId=invitation.id;
      // Yes accepts this specific dated offer, not an automatically selected next slot.
      c.windowId=invitation.order_invitation_json.windowId;
      c.cart??=[];
      c.deliveryLocation??=locationFromAddress(c.deliveryAddress??'');
      c.deliveryLocation.municipality??='Itagüí';
      delete c.deliveryPreference;delete c.coveragePromptKey;delete c.soldOutWindowId;delete c.offeredWindowIds;
      c.menuVersion=this.orders.menuVersion();c.menuSignature=this.menuSignature();
      await releaseManualPause(tx,message.phone,message.eventId,new Date());
      await tx.query('UPDATE whatsapp_chat_controls SET paused_until=now(),updated_at=now(),updated_by=$2 WHERE customer_phone=$1',[message.phone,'customer-invitation · '+message.eventId]);
      await tx.query(`UPDATE message_outbox SET status='cancelled' WHERE customer_id=$1 AND kind='staff_resume' AND status IN ('pending','failed')`,[invitation.customer_id]);
      const next:Session={state:'CHOOSING_ITEM',context:c};
      await tx.query(`INSERT INTO conversations(phone_e164,state,context_json,updated_at) VALUES($1,$2,$3::jsonb,now())
        ON CONFLICT(phone_e164) DO UPDATE SET state=excluded.state,context_json=excluded.context_json,updated_at=excluded.updated_at`,[message.phone,next.state,JSON.stringify(c)]);
      return {existing:[],invitation,session:next};
    });
    if(!accepted)return null;
    if(accepted.existing.length){
      await this.messaging.sendNow(message.phone,`Ya tienes ${accepted.existing.length===1?'el pedido':'los pedidos'} ${accepted.existing.map(o=>o.public_id).join(', ')} registrado${accepted.existing.length===1?'':'s'}. Conservamos esos datos; no he creado otro pedido. Dime qué quieres ajustar.`);
      return {invitationAccepted:true,existingOrder:true};
    }
    const session=accepted.session!,c=session.context;
    const available=await this.orders.availableWindows('delivery',false,true,accepted.invitation.order_invitation_json.deliveryZone);
    const offered=available.find(w=>w.id===c.windowId);
    if(!offered)return this.showSoldOutOptions(message.phone,session,c.windowId);
    const introduction=`¡Claro! 🦀 Armemos tu pedido para Itagüí: ${windowLabel(offered.starts_at,offered.ends_at,this.cfg.BUSINESS_TIMEZONE)}. Se confirma al verificar el pago completo por transferencia.`;
    const menu=this.orders.menu(),cart=c.cart??[];
    const current=cart.filter(l=>menu.some(i=>i.id===l.menuItemId||i.slug===l.menuItemId));
    const removed=current.length!==cart.length;c.cart=current;
    const contacts=await knownDeliveryContactDetails(this.db,message.phone);
    c.deliveryContactPhones??=contacts.phones;c.deliverySingleContactAccepted??=contacts.singleAccepted;
    // If they include food choices in the acceptance, use that same message now.
    if(!removed&&/\b(combo|langostinos?|kanikama|cangrejo)\b/.test(normalizeText(message.text))&&this.cfg.AI_ORDERING_ENABLED&&this.cashOnDelivery()){
      await this.save(message.phone,session);await this.messaging.sendNow(message.phone,introduction);
      return this.naturalOrder(message,session);
    }
    let question='¿Qué combo o mariscos te gustaría pedir y cuántos?';
    if(this.cartHasPlate(current)){
      const missing=current.some(l=>menu.find(i=>i.id===l.menuItemId||i.slug===l.menuItemId)?.category==='plate'&&!l.customization?.spice);
      if(missing){session.state='CHOOSING_SPICE';question='¿Qué picante prefieres: suave o medio?';}
      else if(!c.deliveryAddress){session.state='ENTERING_ADDRESS';question='¿A qué dirección de Itagüí lo llevamos? Incluye el número y los detalles de acceso.';}
      else {session.state='REVIEWING';question='¿Seguimos con estos datos o quieres cambiar algo?';}
    }
    const summary=current.length?'\n\nConservo tu selección:\n'+current.map(l=>`• ${saleLineLabel(menu.find(i=>i.id===l.menuItemId||i.slug===l.menuItemId)!.name,l.quantity,l.customization)}${l.customization?.spice?' · '+l.customization.spice:''}`).join('\n')+'\nTotal actual con domicilio: '+cop((await this.orders.quote(current,c.referralCode)).total)+(c.deliveryAddress?'\nDirección: '+c.deliveryAddress:''):'';
    await this.save(message.phone,session);
    if(!current.length)await this.sendFoodMenu(message.phone,true);
    await this.messaging.sendNow(message.phone,introduction+summary+(removed?'\nUno de los productos anteriores ya no está disponible.':'')+'\n\n'+question,'invitation_order_start');
    return {state:session.state,invitationAccepted:true};
  }

  private async welcome(phone: string) {
    if(this.cfg.NEW_ORDERS_PAUSED)return this.sendOrderingPaused(phone);
    const contacts=await knownDeliveryContactDetails(this.db,phone);
    const session: Session = { state: 'CHOOSING_ITEM', context: { orderingOptIn: true, deliveryContactPhones:contacts.phones,deliverySingleContactAccepted:contacts.singleAccepted, cart: [], menuVersion:this.orders.menuVersion(),menuSignature:this.menuSignature() } };
    await this.save(phone, session);
    const windows = await this.orderingWindows(session.context);
    if(this.cfg.AI_ORDERING_ENABLED&&this.cashOnDelivery()){
      // Establish delivery timing before showing the menu or collecting food choices.
      if(!windows.some(w=>w.remaining>0 && (!w.prepayment_required||this.cfg.NEW_ORDERS_FULL_PAYMENT||this.cfg.NEW_ORDERS_TOTAL_CAP)))return this.showSoldOutOptions(phone,session);
      if(!this.cfg.FAST_CHECKOUT_ENABLED)await this.messaging.sendNow(phone,this.copy('ordering_intro',{'cupos-disponibles':deliveryAvailability(windows as any,this.cfg.BUSINESS_TIMEZONE)}));
      await this.sendFoodMenu(phone,true);
      return {state:session.state};
    }
    if(!windows.some(w=>w.remaining>0 && (!w.prepayment_required||this.cfg.NEW_ORDERS_FULL_PAYMENT||this.cfg.NEW_ORDERS_TOTAL_CAP)))return this.showSoldOutOptions(phone,session);
    const nextWindow = windows.find(window=>window.remaining>0);
    const preorderTiming = nextWindow
      ? this.copy('schedule',{delivery:windowLabel(nextWindow.starts_at,nextWindow.ends_at,this.cfg.BUSINESS_TIMEZONE),cutoff:deadlineLabel(nextWindow.order_cutoff_at,this.cfg.BUSINESS_TIMEZONE)})
      : this.copy('closed');
    await this.sendFoodMenu(phone,true);
    // WhatsApp may take a little longer to fetch and render media than text.
    // Give the menu a head start so it appears before the instructions.
    if (this.cfg.WHATSAPP_PROVIDER === 'meta') {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    await this.messaging.sendNow(phone,
      this.copy(this.cfg.AI_ORDERING_ENABLED&&this.cashOnDelivery()?'ordering_intro':'welcome',{schedule:preorderTiming,'cupos-disponibles':windows.length?deliveryAvailability(windows as Array<{starts_at:string;remaining:number}>,this.cfg.BUSINESS_TIMEZONE):this.copy('closed'),'proxima-franja':nextWindow ? windowLabel(nextWindow.starts_at,nextWindow.ends_at,this.cfg.BUSINESS_TIMEZONE) : 'aún por confirmar'}));
    return { state: session.state };
  }

  private async chooseItem(phone: string, text: string, session: Session) {
    const referral=await this.extractReferral(text,session);
    if(referral.invalid) {
      await this.messaging.sendNow(phone,'Ese código no existe, venció o no está activo. Revisa el código y vuelve a enviar tu selección, o continúa sin código.');
      return {state:session.state};
    }
    text=referral.text;
    const hasReferral=referral.found;
    if(hasReferral&&!text.trim()) {
      await this.save(phone,session);
      await this.messaging.sendNow(phone,'Código guardado. ¿Qué deseas pedir?');
      return {state:session.state};
    }
    const cart = session.context.cart ?? [];
    if (normalizeMenuInput(text) === 'listo') {
      if (!this.cartHasPlate(cart)) {
        await this.messaging.sendNow(phone, this.copy('needs_item'));
        return { state: session.state };
      }
      session.context.fulfillmentType = 'delivery';
      return this.showDeliveryWindows(phone, session);
    }
    const parsed = parseMenuText(text, this.orders.menu());
    for (const id of parsed.extraIds) this.addToCart(cart, id,undefined,parsed.quantities?.[id]??1);
    session.context.cart = cart;
    if (!parsed.primaryIds.length) {
      if (parsed.extraIds.length) {
        const names = this.namesFor(parsed.extraIds);
        await this.save(phone, session);
        await this.messaging.sendNow(phone, this.copy('extras_first',{items:names}));
        return { state: session.state };
      }
      await this.messaging.sendNow(phone,
        this.copy('unknown_item'));
      return { state: session.state };
    }
    if(this.cfg.STANDARD_SPICE){
      if(parsed.spice&&parsed.spice!==this.cfg.STANDARD_SPICE){await this.messaging.sendNow(phone,standardSpiceNotice(this.cfg.STANDARD_SPICE));return {state:session.state};}
      parsed.spice=this.cfg.STANDARD_SPICE;
    }
    session.context.pendingSelection = { quantities:parsed.quantities,menuItemIds: parsed.primaryIds, extraIds: parsed.extraIds, sauce: parsed.sauce, spice: parsed.spice };
    if (this.linkedMenu()) session.context.pendingSelection!.sauce = parsed.sauce = 'Salsa de la casa';
    if (this.linkedMenu() && parsed.spice && !['Suave','Medio'].includes(parsed.spice)) throw new Error('Este menú ofrece picante Suave o Medio');
    if (!parsed.sauce) {
      session.state = 'CHOOSING_SAUCE';
      await this.save(phone, session);
      await this.messaging.sendNow(phone, this.copy('sauce',{options:saucePrompt()}));
      return { state: session.state };
    }
    if (!parsed.spice) {
      session.state = 'CHOOSING_SPICE';
      await this.save(phone, session);
      await this.messaging.sendNow(phone, this.copy('spice',{options:this.linkedMenu()?'Suave o Medio':spicePrompt()}));
      return { state: session.state };
    }
    return this.finalizeSelection(phone, session);
  }

  private async chooseSauce(phone: string, text: string, session: Session) {
    const sauce = parseSauce(text);
    if (!sauce) {
      await this.messaging.sendNow(phone, this.copy('invalid_sauce',{options:saucePrompt()}));
      return { state: session.state };
    }
    session.context.pendingSelection!.sauce = sauce;
    if(this.cfg.STANDARD_SPICE)session.context.pendingSelection!.spice=this.cfg.STANDARD_SPICE;
    if (!session.context.pendingSelection!.spice) {
      session.state = 'CHOOSING_SPICE';
      await this.save(phone, session);
      await this.messaging.sendNow(phone, this.copy('spice',{options:this.linkedMenu()?'Suave o Medio':spicePrompt()}));
      return { state: session.state };
    }
    return this.finalizeSelection(phone, session);
  }

  private async chooseSpice(phone: string, text: string, session: Session) {
    if(this.cfg.STANDARD_SPICE){session.context.pendingSelection!.spice=this.cfg.STANDARD_SPICE;return this.finalizeSelection(phone,session);}
    const spice = parseSpice(text);
    if (!spice || (this.linkedMenu() && !['Suave','Medio'].includes(spice))) {
      await this.messaging.sendNow(phone, this.copy('invalid_spice',{options:this.linkedMenu()?'Suave o Medio':spicePrompt()}));
      return { state: session.state };
    }
    session.context.pendingSelection!.spice = spice;
    return this.finalizeSelection(phone, session);
  }

  private async finalizeSelection(phone: string, session: Session) {
    const pending = session.context.pendingSelection!;
    const customization = { sauce: pending.sauce, spice: pending.spice };
    for (const id of pending.menuItemIds) this.addToCart(session.context.cart ??= [], id, customization,pending.quantities?.[id]??1);
    const primary = this.orders.menu().find((item) => item.id === pending.menuItemIds[0]);
    session.context.lastPlateId = primary?.id;
    delete session.context.pendingSelection;
    session.state = 'UPSELL';
    await this.save(phone, session);
    const added=this.copy('added',{items:this.selectionBulletText([...pending.menuItemIds,...(pending.extraIds??[])],pending.quantities),sauce:customization.sauce??'',spice:customization.spice??''});
    if(this.orders.menu().some(i=>['kit_opcional','drink_6'].includes(i.slug??''))){await this.messaging.sendNow(phone,added);return this.showDeliveryWindows(phone,session);}
    if(this.cashOnDelivery()&&this.step('upsell')) {
      await this.messaging.sendNow(phone,added);
      let prompt=this.upsellText(primary,session.context.cart??[]);
      if(prompt.length>1024){await this.messaging.sendNow(phone,prompt);prompt='¿Continuamos con la entrega?';}
      await this.messaging.sendButtonsNow(phone,prompt,[{id:'kc:continue',title:'Continuar'}]);
    } else await this.messaging.sendNow(phone,added+(this.step('upsell')?'\n\n'+this.upsellText(primary,session.context.cart??[]):''));
    if(!this.step('upsell')) return this.showDeliveryWindows(phone,session);
    return { state: session.state };
  }

  private async chooseUpsell(phone: string, text: string, session: Session) {
    const plate = this.orders.menu().find((item) => item.id === session.context.lastPlateId);
    const suggestions = this.suggestionsFor(plate, session.context.cart ?? []);
    const referral=await this.extractReferral(text,session);
    if(referral.invalid) {
      await this.messaging.sendNow(phone,'Ese código no existe, venció o no está activo. Revisa el código y vuelve a enviar tu selección, o continúa sin código.');
      return {state:session.state};
    }
    text=referral.text;
    const hasReferral=referral.found;
    const declined=parseExtras(text).decline;
    if(declined){session.context.extrasDeclined=true;session.context.checkoutExtrasHandled=true;session.context.aiExtrasHandled=true;delete session.context.checkoutExtrasPending;}
    if (!declined&&!['no','listo','continuar'].includes(normalizeMenuInput(text)) && !(hasReferral&&!text.trim())) {
      const parsed = parseMenuText(text, this.orders.menu());
      const selected = parsed.extraIds;
      if (!selected.length) {
        if(this.cashOnDelivery()&&this.step('referral')) {
          await this.messaging.sendNow(phone,'No reconocí el extra o código. Envía el nombre del extra, CÓDIGO seguido de tu código, o NO para continuar.');
          return {state:session.state};
        }
        await this.messaging.sendNow(phone,
          this.copy('invalid_extra',{items:suggestions.map(item=>'• '+item.name).join('\n')}));
        return { state: session.state };
      }
      for (const id of selected) this.addToCart(session.context.cart ??= [], id,undefined,parsed.quantities?.[id]??1);
      await this.messaging.sendNow(phone, this.copy('extras_added',{items:this.selectionBulletText(selected,parsed.quantities)}));
    }
    delete session.context.lastPlateId;
    session.context.fulfillmentType = 'delivery';
    return this.showDeliveryWindows(phone, session);
  }

  private async chooseFulfillment(phone: string, text: string, session: Session) {
    void text;
    session.context.fulfillmentType = 'delivery';
    return this.showDeliveryWindows(phone, session);
  }

  private async showDeliveryWindows(phone: string, session: Session) {
    const windows = await this.orderingWindows(session.context);
    if (!windows.length) {
      return this.showSoldOutOptions(phone,session);
    }
    session.context.fulfillmentType = 'delivery';
    session.state = 'CHOOSING_WINDOW';
    session.context.offeredWindowIds = windows.map(w => w.id);
    await this.save(phone, session);
    await this.messaging.sendNow(phone,
      this.copy('delivery',{windows:windows.map((w,i)=>`${i+1}. ${windowLabel(w.starts_at,w.ends_at,this.cfg.BUSINESS_TIMEZONE)}\n   ${w.pickup_available?'recogida disponible':w.prepayment_required?'solo con pago completo por transferencia':`${w.remaining} cupos disponibles`}`).join('\n\n')}));
    return { state: session.state };
  }

  private async chooseWindow(phone: string, text: string, session: Session) {
    const windows = await this.orderingWindows(session.context);
    const response = text.match(/^(\d+)\s*[,;:\-]?\s*(.*)$/);
    const choice = Number(response?.[1]);
    const address = response?.[2]?.trim() ?? '';
    const chosenId = session.context.offeredWindowIds?.[choice - 1];
    const window = chosenId ? windows.find(w => w.id === chosenId) : windows[choice - 1];
    if (!window) {
      return this.showDeliveryWindows(phone, session);
    }
    if(window.prepayment_required&&!session.context.fullPrepayment)return this.showSoldOutOptions(phone,session,window.id);
    session.context.windowId = window.id;
    session.context.fulfillmentType = 'delivery';
    if (address.length < 8) {
      session.state = 'ENTERING_ADDRESS';
      await this.save(phone, session);
      await this.messaging.sendNow(phone,
        this.copy('address',{delivery:windowLabel(window.starts_at,window.ends_at,this.cfg.BUSINESS_TIMEZONE)}));
      return { state: session.state };
    }
    session.context.deliveryAddress = address;
    if(this.cashOnDelivery()) return this.completeCashOnDelivery(phone,session);
    if(!this.step('referral')) return this.enterReferral(phone,'no',session);
    session.state = 'ENTERING_REFERRAL';
    await this.save(phone, session);
    await this.messaging.sendNow(phone,
      this.copy('referral'));
    return { state: session.state };
  }

  private async enterAddress(phone: string, rawText: string, session: Session) {
    if (rawText.trim().length < 8) {
      await this.messaging.sendNow(phone, this.copy('invalid_address'));
      return { state: session.state };
    }
    session.context.deliveryAddress = rawText.trim();
    if(this.cashOnDelivery()) return this.completeCashOnDelivery(phone,session);
    if(!this.step('referral')) return this.enterReferral(phone,'no',session);
    session.state = 'ENTERING_REFERRAL';
    await this.save(phone, session);
    await this.messaging.sendNow(phone,
      this.copy('referral'));
    return { state: session.state };
  }

  private async enterReferral(phone: string, text: string, session: Session) {
    if (!['no','listo'].includes(normalizeMenuInput(text))) {
      const referral = (await this.db.query<{ code: string }>(`SELECT code FROM referral_codes WHERE lower(code) = lower($1) AND active = TRUE`, [text])).rows[0];
      if (!referral) {
        await this.messaging.sendNow(phone, this.copy('invalid_referral'));
        return { state: session.state };
      }
      session.context.referralCode = referral.code;
    }
    if(this.cashOnDelivery()) return this.completeCashOnDelivery(phone,session);
    session.context.reviewTotalCop = (await this.orders.quote(session.context.cart??[],session.context.referralCode,session.context.deliveryPreference)).total;
    session.context.menuVersion=this.orders.menuVersion();
    session.context.menuSignature=this.menuSignature();
    session.state = 'REVIEWING';
    await this.save(phone, session);
    await this.messaging.sendNow(phone,
      this.copy('confirm',{summary:await this.reviewText(session.context)}));
    return { state: session.state };
  }

  private async review(phone: string, text: string, session: Session, displayName?: string) {
    if (text === 'no') {
      await this.save(phone, { state: 'WELCOME', context: {} });
      return this.welcome(phone);
    }
    if (!['si', 'sí'].includes(text)) {
      await this.messaging.sendNow(phone, this.copy('invalid_confirmation'));
      return { state: session.state };
    }
    if(this.cashOnDelivery()) return this.completeCashOnDelivery(phone,session);
    if(!this.cfg.FAST_CHECKOUT_ENABLED&&needsDeliveryContacts(session.context))return this.askDeliveryContacts(phone,session);
    if(!this.cfg.FAST_CHECKOUT_ENABLED&&await this.offerCheckoutExtras(phone,session))return {state:'UPSELL'};
    const result = await this.orders.create({
      extrasDeclined:session.context.extrasDeclined,
      phone,
      displayName,
      cart: session.context.cart ?? [],
      fulfillmentType: session.context.fulfillmentType!,
      windowId: session.context.windowId!,
      deliveryAddress: session.context.deliveryAddress,
      deliveryContactPhones:session.context.deliveryContactPhones,
      deliverySingleContactAccepted:session.context.deliverySingleContactAccepted,
      referralCode: session.context.referralCode,
      expectedTotalCop: session.context.reviewTotalCop,
      expectedMenuVersion:session.context.menuVersion
    });
    await this.save(phone, { state: 'MAIN_MENU', context: {} });
    const paymentLink = result.payment.checkoutUrl
      ? `\n\n*Paga de forma segura con Bancolombia*\n${result.payment.checkoutUrl}`
      : '';
    await this.messaging.sendNow(phone,
      this.copy('payment',{reference:result.publicId,total:cop(result.total),instructions:result.payment.instructions+paymentLink,verification:this.cfg.PAYMENT_PROVIDER==='manual_transfer'?'El equipo confirmará el pedido después de verificar el abono. Consulta el estado escribiendo ESTADO '+result.publicId+'.':'Confirmaremos tu pedido automáticamente una vez recibamos el pago.'}),
      'payment_instructions', result.orderId);
    return { state: 'MAIN_MENU', order: result };
  }

  private async extractReferral(text:string,session:Session) {
    if(!this.cashOnDelivery()||!this.step('referral'))return {text,found:false,invalid:false};
    const explicit=text.match(/\bc[oó]digo\s*[:=]?\s*([\w-]+)/i);
    const codes=(await this.db.query<{code:string;free_delivery:boolean}>(`SELECT code,free_delivery FROM referral_codes WHERE active=TRUE AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>=now())`)).rows;
    const tokens=text.split(/[\s,;]+/);
    const code=explicit?codes.find(c=>c.code.toLowerCase()===explicit[1]!.toLowerCase()):codes.find(c=>tokens.some(t=>t.toLowerCase()===c.code.toLowerCase()));
    if(explicit&&!code)return {text,found:false,invalid:true};
    if(!code)return {text,found:false,invalid:false};
    session.context.referralCode=code.code;
    return {text:explicit?text.replace(explicit[0],''):tokens.filter(t=>t.toLowerCase()!==code.code.toLowerCase()).join(' '),found:true,invalid:false};
  }

  private async askDeliveryContacts(phone:string,session:Session) {
    session.context.awaitingDeliveryContacts=true;
    session.state='REVIEWING';
    await this.save(phone,session);
    await this.messaging.sendNow(phone,deliveryContactPrompt(session.context.deliveryContactPhones??[],session.context.deliverySingleContactAccepted));
    return {state:session.state,awaitingDeliveryContacts:true};
  }

  private async offerCheckoutExtras(phone:string,session:Session){
    const c=session.context;if(c.checkoutExtrasHandled||c.extrasDeclined){c.checkoutExtrasHandled=true;delete c.checkoutExtrasPending;return false;}
    const catalog=(await extrasCatalog(this.db)).filter(i=>!(c.cart??[]).some(l=>l.menuItemId===i.id));
    if(!catalog.length){c.checkoutExtrasHandled=true;return false;}
    c.checkoutExtrasPending=true;session.state='UPSELL';
    await this.save(phone,session);
    const menu=this.orders.menu(),cart=c.cart??[];
    const personal=cart.filter(l=>/^Combo personal/i.test(menu.find(i=>i.id===l.menuItemId)?.name??''));
    const medium=cart.filter(l=>/^Combo mediano/i.test(menu.find(i=>i.id===l.menuItemId)?.name??''));
    const servingCount=personal.reduce((n,l)=>n+l.quantity,0)+medium.reduce((n,l)=>n+2*l.quantity,0);
    const coke=catalog.find(i=>i.slug==='drink_6');
    const availableCokes=coke?await stockRemaining(this.db,'drink_6'):null;
    const suggested=Math.min(servingCount===1?1:2,availableCokes??2);
    const prompt=extrasPrompt(catalog)+(coke?`\n\n${servingCount>0&&servingCount<=2?`¿Agregamos ${suggested} Coca-Cola${suggested===1?'':'s'} por ${cop(coke.price_cop*suggested)}?`:'Puedes elegir la cantidad de bebidas y kits.'}`:'');
    await this.messaging.sendButtonsNow(phone,prompt,[...(coke?[{id:`kc:extras:coke:${suggested}`,title:`${suggested} Coca-Cola${suggested===1?'':'s'}`}]:[]),{id:'kc:extras:no',title:'No, gracias'}]);return true;
  }

  private async completeCashOnDelivery(phone:string,session:Session) {
    const c=session.context;
    const available=await this.orderingWindows(c);
    const chosen=available.find(w=>w.id===c.windowId);
    if(!chosen||(chosen.prepayment_required&&!c.fullPrepayment))return this.showSoldOutOptions(phone,session,c.windowId);
    if(!this.cfg.FAST_CHECKOUT_ENABLED&&needsDeliveryContacts(c))return this.askDeliveryContacts(phone,session);
    delete c.awaitingDeliveryContacts;
    if(!this.cfg.FAST_CHECKOUT_ENABLED&&await this.offerCheckoutExtras(phone,session))return {state:'UPSELL'};
    if(c.pendingCrabPortions?.length)throw new DraftClarification('Falta elegir 100 g o la pieza entera de cangrejo.');
    const location=c.deliveryLocation??locationFromAddress(c.deliveryAddress??'');
    const coverage=await this.orders.coverage(location,c.deliveryPreference,c.windowId);
    if(this.cfg.FAST_CHECKOUT_ENABLED){
      if(c.deliveryContactPhones?.length)coverage.contactPhones=[...c.deliveryContactPhones];
      else if(/^\+[1-9]\d{7,14}$/.test(phone))coverage.contactPhones=[phone];
      if(c.deliveryAddress&&!/\d/.test(c.deliveryAddress)&&!['pickup','own_courier'].includes(c.deliveryPreference??''))coverage.needsReview=true;
      if(c.checkoutReviewNotes?.length)coverage.checkoutReview={status:'pending',notes:[...c.checkoutReviewNotes]};
    }
    let address=c.deliveryAddress;
    // Preserve the customer's location clarification in the dispatch address.
    if(address)for(const place of [location.area,location.municipality])if(place&&!normalizeText(address).includes(normalizeText(place)))address+=`, ${place}`;
    if(!address&&['pickup','own_courier'].includes(c.deliveryPreference??''))address=pickupLocationNotice;
    const result=await this.orders.create({phone,reviewNotes:c.checkoutReviewNotes,extrasDeclined:c.extrasDeclined,fullPrepayment:c.fullPrepayment,cart:c.cart??[],fulfillmentType:'delivery',windowId:c.windowId!,deliveryAddress:address,deliveryCoverage:coverage,deliveryContactPhones:this.cfg.FAST_CHECKOUT_ENABLED?undefined:c.deliveryContactPhones,deliverySingleContactAccepted:c.deliverySingleContactAccepted,referralCode:c.referralCode,expectedTotalCop:(await this.orders.quote(c.cart??[],c.referralCode,c.deliveryPreference)).total,expectedMenuVersion:c.menuVersion});
    // Build the receipt from stored order snapshots, never from a changing menu.
    const order=await this.orders.orderByPublicId(result.publicId);
    const weightNotice=variableWeightNotice(order.lines.map((l:any)=>l.customization));
    const items=order.lines.map((line:any)=>`• ${saleLineLabel(line.name,line.quantity,line.customization)}${line.customization?.spice?' · '+line.customization.spice:''}${line.customization?.sauce?' · '+line.customization.sauce:''} · ${cop(line.line_total_cop)}`).join('\n')+weightNotice;
    if(result.fullPayment){
      if(this.cfg.FAST_CHECKOUT_ENABLED){
        const review=c.checkoutReviewNotes?.length?'\n\n📝 Detalles por revisar con el equipo:\n'+c.checkoutReviewNotes.map(n=>'• '+n).join('\n'):'';
        const body=`🧾 *Pedido ${order.public_id} · pendiente de pago*\n\n${items}\nDomicilio: ${cop(order.delivery_fee_cop-order.delivery_discount_cop)}\n*Total: ${cop(result.total)}*\n\n📅 ${windowLabel(order.starts_at,order.ends_at,this.cfg.BUSINESS_TIMEZONE)}\n📍 ${order.delivery_address}\n\n${result.payment.instructions}\nEnvíanos el comprobante y el nombre del titular. Confirmamos al verificar el pago.${coverage.needsReview?' La entrega queda sujeta a revisión de la dirección y cobertura.':''}${review}`;
        await this.messaging.sendNow(phone,body,'reservation_instructions',order.id);
        return {state:'MAIN_MENU',order:result};
      }
      const body=`🧾 *Pedido ${order.public_id} · pendiente de pago completo*\n\n${items}\n\n📅 ${windowLabel(order.starts_at,order.ends_at,this.cfg.BUSINESS_TIMEZONE)}\n${order.delivery_address}\n\n*Total${weightNotice?' estimado':''}: ${cop(result.total)}*\n`+`Para garantizar este cupo, paga el total por transferencia.\n\n${result.payment.instructions}\nReferencia del pedido: ${order.public_id}\nEnvía el comprobante antes de ${deadlineLabel(result.expiresAt,this.cfg.BUSINESS_TIMEZONE)}. Confirmaremos el pedido cuando el equipo verifique el pago completo.`+(coverage.needsReview?'\nEl equipo revisará la dirección; la confirmación final requiere verificar el pago y la cobertura.':'')+'\n\n'+deliveryWindowNotice(order.delivery_coverage);
      await this.messaging.sendNow(phone,body,'reservation_instructions',order.id);
      return {state:'MAIN_MENU',order:result};
    }
    if(coverage.needsReview){
      const preference=coverage.preference==='pickup'?pickupLocationNotice:coverage.preference==='own_courier'?'Recogida con mensajero propio solicitada. '+pickupLocationNotice:'Entrega solicitada para revisión';
      await this.messaging.sendNow(phone,`🦀 *Pedido registrado · entrega por coordinar*\n\nReferencia: ${order.public_id}\n${items}\n\nFranja solicitada: ${windowLabel(order.starts_at,order.ends_at,this.cfg.BUSINESS_TIMEZONE)}\n${preference}\nDirección indicada: ${order.delivery_address}\n\nTotal calculado: ${cop(order.total_cop)}${order.referral_code_snapshot?'\nCódigo: '+order.referral_code_snapshot:''}\n\nLa cobertura, modalidad y tarifa final requieren revisión del equipo; el domicilio aún no está confirmado. Conservamos tu pedido.${result.deposit?' Para este valor corresponde un abono de '+cop(result.deposit)+'.\n\n'+result.payment.instructions+'\nReferencia del pedido: '+order.public_id+'\nEnvía el comprobante; la confirmación final requiere verificar el pago y la cobertura.':' El pago se coordina al resolver la entrega.'}`,'order_confirmation',order.id);
      return {state:'MAIN_MENU',order:result,deliveryNeedsReview:true};
    }
    if(coverage.method==='pickup'){
      const body=(result.deposit?'🧾 *Pedido para recoger · pendiente de abono*':'✅ *Pedido confirmado para recoger*')+`\n\nReferencia: ${order.public_id}\n${items}\n\n📅 ${windowLabel(order.starts_at,order.ends_at,this.cfg.BUSINESS_TIMEZONE)}\n\n*Total${weightNotice?' estimado':''}: ${cop(order.total_cop)}*\nSin costo de domicilio.`+(order.referral_code_snapshot?'\nCódigo: '+order.referral_code_snapshot:'')+(result.deposit?`\n*Abono para confirmar: ${cop(result.deposit)}*\nSaldo al recoger después del abono: ${cop(result.total-result.deposit)}\n\n${result.payment.instructions}`:'\nPagas al recoger; no necesitas abono.')+'\n\n'+(result.deposit?deliveryWindowNotice(order.delivery_coverage):orderConfirmationNotice(order));
      await this.messaging.sendNow(phone,body,result.deposit?'reservation_instructions':'order_confirmation',order.id);
      return {state:'MAIN_MENU',order:result};
    }
    await this.messaging.sendNow(phone,this.copy(result.deposit?'deposit_required':'order_confirmed',{deposit:cop(result.deposit),balance:cop(result.total-result.deposit),instructions:result.payment.instructions,reference:order.public_id,items,delivery:windowLabel(order.starts_at,order.ends_at,this.cfg.BUSINESS_TIMEZONE)+'\n'+order.delivery_address,referral:((order.delivery_coverage?.contactPhones?.length?'\nTeléfonos de contacto: '+order.delivery_coverage.contactPhones.join(' · '):'')+(order.referral_code_snapshot?'\nCódigo de referido: '+order.referral_code_snapshot:''))+'\nDomicilio: '+(order.delivery_discount_cop>0?'gratis con tu código (ahorras '+cop(order.delivery_discount_cop)+')':cop(order.delivery_fee_cop)),total:cop(order.total_cop)})+'\n\n'+(result.deposit?deliveryWindowNotice(order.delivery_coverage):orderConfirmationNotice(order)),result.deposit?'reservation_instructions':'order_confirmation',order.id);
    return {state:'MAIN_MENU',order:result};
  }

  private cartTotal(cart: NonNullable<ConversationContext['cart']>) {return cart.reduce((s,l)=>s+lineCharge(this.orders.menu().find(i=>i.id===l.menuItemId)!.price_cop,l.quantity),0);}
  private assistantMenu() {
    return this.orders.menu().map(i=>({id:i.id,name:i.name,aliases:(metadata(i).aliases??[]).filter((a:unknown)=>typeof a==='string'),description:i.description,priceCop:i.price_cop,category:i.category,crabPortion:portionConfig(i)?{...portionConfig(i),explanation:crabExplanation(i,false)}:null,baseQuantityGrams:metadata(i).kitchen?.product?.unit==='g'?metadata(i).kitchen?.product?.baseQuantity:null,spices:this.cfg.STANDARD_SPICE?[this.cfg.STANDARD_SPICE]:this.linkedMenu()?['Suave','Medio']:['Suave','Medio','Picante','Muy picante']}));
  }
  private menuSignature() {return JSON.stringify(this.orders.menu().map(i=>[i.id,i.name,i.price_cop,i.description]));}
  private hasMenuImage() {return !!this.cfg.MENU_IMAGE_URL || this.cfg.MENU_IMAGE_PATH !== './assets/menu-example.jpg';}
  private async sendMenuOverview(phone:string) {
    return this.sendFoodMenu(phone);
  }
  private async sendFoodMenu(phone:string,_referenceImage=false) {
    await this.messaging.sendImageNow(phone,this.responseImageUrl(responseImages.combos),'Combos King Cajun · precios en COP.','menu_image');
    return this.messaging.sendImageNow(phone,this.responseImageUrl(responseImages.build),'Arma tu propio boil · cada ingrediente se cobra por separado. Precios en COP.','menu_extras_image');
  }
  private currentMenuText() {return this.copy('menu',{items:this.orders.menu().map(i=>`*${i.name}* · ${cop(i.price_cop)}${metadata(i).kitchen?.product?.unit==='g'?' / 100 g':''}\n${i.description}`).join('\n\n')});}
  private linkedMenu() { return this.orders.menu().some(item => Boolean(metadata(item).kitchen)); }

  private suggestionsFor(plate: ReturnType<OrderService['menu']>[number] | undefined, cart: NonNullable<ConversationContext['cart']>) {
    if(this.orders.menuVersion()>0)return this.orders.menu().filter(i=>i.category!=='plate'&&!cart.some(l=>l.menuItemId===i.id)).slice(0,2);
    const skus = plate ? (metadata(plate).upsell_skus ?? []) : [];
    const preferred = skus.length ? skus : this.linkedMenu() ? ['KC-KITCHEN-side-corn', 'KC-KITCHEN-side-potato'] : ['ADD-CORN', 'DRINK-TEA'];
    const candidates = [...new Set([...preferred, 'ADD-CORN', 'ADD-CAJUN-FRIES', 'ADD-RICE', 'DRINK-TEA', 'DRINK-WATER'])];
    const cartIds = new Set(cart.map((line) => line.menuItemId));
    return candidates
      .map((sku) => this.orders.menu().find((item) => item.sku === sku))
      .filter((item): item is NonNullable<typeof item> => item !== undefined && !cartIds.has(item.id))
      .slice(0, 2);
  }
  private upsellText(plate: ReturnType<OrderService['menu']>[number] | undefined, cart: NonNullable<ConversationContext['cart']>) {
    const suggestions = this.suggestionsFor(plate, cart);
    if (!suggestions.length) return this.copy('upsell_empty');
    return this.copy('upsell',{items:suggestions.map(item=>`• ${item.name} · ${cop(item.price_cop)}`).join('\n')});
  }
  private addToCart(cart: NonNullable<ConversationContext['cart']>, id: string, customization?: { sauce?: string; spice?: string },quantity=1) {
    const signature = JSON.stringify(customization ?? {});
    const line = cart.find((entry) => entry.menuItemId === id && JSON.stringify(entry.customization ?? {}) === signature);
    if (line) line.quantity+=quantity; else cart.push({ menuItemId: id, quantity, ...(customization ? { customization } : {}) });
  }
  private namesFor(ids: string[]) {
    const menu = this.orders.menu();
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts].map(([id, quantity]) => {
      const name = menu.find((item) => item.id === id)?.name ?? 'producto';
      return quantity > 1 ? `${quantity}× ${name}` : name;
    }).join(', ');
  }
  private selectionBulletText(ids: string[],quantities?:Record<string,number>) {
    const menu = this.orders.menu();
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + (quantities?.[id]??1));
    return [...counts].map(([id, quantity]) => {
      const name = menu.find((item) => item.id === id)?.name ?? 'Producto';
      return `• ${quantity !== 1 ? `${quantity}× ` : ''}${name}`;
    }).join('\n');
  }
  private cartHasPlate(cart: Array<{ menuItemId: string; quantity: number }>) {
    const plateIds = new Set(this.orders.menu().filter((item) => item.category === 'plate').map((item) => item.id));
    return cart.some((line) => plateIds.has(line.menuItemId));
  }
  private async reviewText(context: ConversationContext) {
    const menu = this.orders.menu();
    const lines = (context.cart ?? []).map((line) => {
      const item = menu.find((candidate) => candidate.id === line.menuItemId)!;
      const options = line.customization?.sauce || line.customization?.spice
        ? ` _(${[line.customization?.sauce, line.customization?.spice].filter(Boolean).join(', ')})_`
        : '';
      return `${line.quantity}× ${item.name}${options} · ${cop(lineCharge(item.price_cop,line.quantity))}`;
    });
    const total = (await this.orders.quote(context.cart??[],context.referralCode,context.deliveryPreference)).total;
    const window = (await this.orderingWindows(context)).find((item) => item.id === context.windowId);
    const fulfillment = context.fulfillmentType === 'delivery'
      ? `• Modalidad: Domicilio\n• Dirección: ${context.deliveryAddress}\n• 📍 Ver en Google Maps:\n  ${this.googleMapsUrl(context.deliveryAddress!)}`
      : '• Modalidad: Recoger';
    return this.copy('review',{items:lines.map(line=>'• '+line).join('\n'),delivery:fulfillment+'\n• Franja: '+(window?windowLabel(window.starts_at,window.ends_at,this.cfg.BUSINESS_TIMEZONE):'ya no disponible'),referral:context.referralCode?'*Referido*\n• Código: '+context.referralCode:'',total:cop(total)});
  }
  private googleMapsUrl(address: string) {
    const query = encodeURIComponent(`${address}, ${this.cfg.DELIVERY_AREA_HINT}`);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  }
  private async ensureCustomer(phone: string, name?: string) {
    const now = new Date().toISOString();
    await this.db.query(`
      INSERT INTO customers (id, phone_e164, display_name, locale, created_at, updated_at)
      VALUES ($1, $2, $3, 'es-CO', $4, $4)
      ON CONFLICT(phone_e164) DO UPDATE SET display_name = COALESCE(excluded.display_name, customers.display_name), updated_at = excluded.updated_at
    `, [randomUUID(), phone, name ?? null, now]);
  }
  private async claimEvent(message: InboundMessage) {
    const now = new Date().toISOString();
    const result = await this.db.query(`
      INSERT INTO webhook_events (id, provider, provider_event_id, payload_json, received_at, processed_at)
      VALUES ($1, 'whatsapp', $2, $3::jsonb, $4, $4)
      ON CONFLICT(provider, provider_event_id) DO NOTHING
      RETURNING id
    `, [randomUUID(), message.eventId, JSON.stringify(message), now]);
    return result.rowCount === 1;
  }
  private async load(phone: string): Promise<Session> {
    const row = (await this.db.query<{ state: ConversationState; context_json: ConversationContext; updated_at: string | Date }>(`SELECT state, context_json, updated_at FROM conversations WHERE phone_e164 = $1`, [phone])).rows[0];
    // Preserve an explicitly started order while the customer or staff takes time
    // to reply. Menu/version and delivery-capacity checks still run on continuation.
    // Only legacy sessions that never opted into ordering are reset here.
    if (row && !['WELCOME', 'MAIN_MENU', 'HUMAN_HANDOFF'].includes(row.state) &&
      !row.context_json.orderingOptIn) {
      const idle: Session = { state: 'MAIN_MENU', context: {} };
      await this.save(phone, idle);
      return idle;
    }
    return row ? { state: row.state, context: row.context_json } : { state: 'WELCOME', context: {} };
  }
  private async save(phone: string, session: Session) {
    await this.db.query(`
      INSERT INTO conversations (phone_e164, state, context_json, updated_at) VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT(phone_e164) DO UPDATE SET state = excluded.state, context_json = excluded.context_json, updated_at = excluded.updated_at
    `, [phone, session.state, JSON.stringify(session.context), new Date().toISOString()]);
  }
}

function hasWindowChoiceEvidence(text:string,evidence:string|null|undefined){
  if(!evidence||!normalizeText(text).includes(normalizeText(evidence)))return false;
  const value=normalizeText(evidence);
  return /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana|tarde|noche|mediodia|horario|franja|primero|primera|segundo|segunda|tercero|tercera|opcion|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(value)||/\b(?:el|para el|dia|a las|de)\s+\d{1,2}\b/.test(value)||/^\d{1,2}(?:\s*[,;:].*)?$/.test(value)||/\d{1,2}[:/]\d{2}/.test(value);
}
