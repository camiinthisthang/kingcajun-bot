export type CartLine = {
  menuItemId: string;
  quantity: number;
  customization?: { sauce?: string; spice?: string; wholePiece?: 'racimo_entero' | 'pata_entera'; wholePieceCount?: number; estimatedWeightGrams?: number; finalWeightPending?: boolean };
};

export type ConversationContext = {
  pendingPaymentExtrasOrderId?: string;
  creatorSubmission?: {links:string[];receivedAt:string;acknowledged:boolean};
  orderingOptIn?: boolean;
  checkoutReviewNotes?: string[];
  orderInvitationId?: string;
  fullPrepayment?: boolean;
  soldOutWindowId?: string;
  aiExtrasHandled?: boolean;
  checkoutExtrasPending?: boolean;
  checkoutExtrasHandled?: boolean;
  extrasDeclined?: boolean;
  cart?: CartLine[];
  fulfillmentType?: 'delivery' | 'pickup';
  windowId?: string;
  offeredWindowIds?: string[];
  deliveryAddress?: string;
  deliveryContactPhones?: string[];
  deliverySingleContactAccepted?: boolean;
  awaitingDeliveryContacts?: boolean;
  deliveryLocation?: import('./services/delivery-coverage.js').DeliveryLocation;
  deliveryPreference?: import('./services/delivery-coverage.js').DeliveryPreference;
  coveragePromptKey?: string;
  referralCode?: string;
  pendingReferralCode?: string;
  reviewTotalCop?: number;
  menuVersion?: number;
  menuSignature?: string;
  lastPlateId?: string;
  pendingCrabPortions?: import('./services/order-assistant.js').Interpretation['edits'];
  pendingSelection?: {
    quantities?: Record<string,number>;
    menuItemIds: string[];
    extraIds?: string[];
    sauce?: string;
    spice?: string;
  };
};

export type ConversationState =
  | 'WELCOME'
  | 'MAIN_MENU'
  | 'SOLD_OUT_OPTIONS'
  | 'WAITLIST_WINDOW'
  | 'HUMAN_HANDOFF'
  | 'CHOOSING_ITEM'
  | 'CHOOSING_SAUCE'
  | 'CHOOSING_SPICE'
  | 'UPSELL'
  | 'CHOOSING_FULFILLMENT'
  | 'CHOOSING_WINDOW'
  | 'ENTERING_ADDRESS'
  | 'ENTERING_REFERRAL'
  | 'REVIEWING';

export type InboundMessage = {
  eventId: string;
  phone: string;
  displayName?: string;
  text: string;
  actionId?: string;
  requestWelcome?: boolean;
  replyToMessageId?: string;
  sentAt?: string;
  location?: {lat:number;lng:number;name?:string;address?:string};
  media?: {type:'image'|'document';id:string;mimeType?:string};
};

export type PaymentConfirmation = {
  eventId: string;
  providerPaymentId: string;
  reference: string;
  amountCop: number;
  status: 'confirmed' | 'failed';
  raw: unknown;
};
