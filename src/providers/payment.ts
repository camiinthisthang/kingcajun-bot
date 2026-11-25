import type { Config } from '../config.js';

export type PaymentRequest = { reference: string; amountCop: number; description: string; customerPhone: string };
export type PaymentInstructions = { checkoutUrl?: string; instructions: string; providerPaymentId?: string };

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: PaymentRequest): Promise<PaymentInstructions>;
}

export class DemoPaymentProvider implements PaymentProvider {
  readonly name = 'demo';
  constructor(private readonly cfg: Config) {}
  async createPayment(input: PaymentRequest) {
    return {
      instructions: `Haz la transferencia por el valor exacto:
• Banco: ${this.cfg.BANK_NAME}
• Cuenta ${this.cfg.BANK_ACCOUNT_TYPE}: ${this.cfg.BANK_ACCOUNT_NUMBER}
• Titular: ${this.cfg.BANK_ACCOUNT_HOLDER}
• Valor: ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(input.amountCop)}
• Referencia: ${input.reference}`
    };
  }
}

/**
 * Adapter for the Botón Bancolombia purchase-intent API. Exact URLs and credentials
 * are supplied by Bancolombia during merchant onboarding and never hard-coded here.
 */
export class BancolombiaPaymentProvider implements PaymentProvider {
  readonly name = 'bancolombia';
  constructor(private readonly cfg: Config) {
    if (!cfg.BANCOLOMBIA_PURCHASE_INTENT_URL || !cfg.BANCOLOMBIA_CLIENT_ID || !cfg.BANCOLOMBIA_CLIENT_SECRET) {
      throw new Error('Falta configurar el onboarding de Botón Bancolombia');
    }
  }
  async createPayment(input: PaymentRequest) {
    const response = await fetch(this.cfg.BANCOLOMBIA_PURCHASE_INTENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IBM-Client-Id': this.cfg.BANCOLOMBIA_CLIENT_ID,
        'X-IBM-Client-Secret': this.cfg.BANCOLOMBIA_CLIENT_SECRET
      },
      body: JSON.stringify({
        reference: input.reference,
        amount: input.amountCop,
        currency: 'COP',
        description: input.description,
        callbackUrl: `${this.cfg.PUBLIC_BASE_URL}/webhooks/payments/bancolombia`
      })
    });
    if (!response.ok) throw new Error(`Bancolombia intent error ${response.status}: ${await response.text()}`);
    const body = await response.json() as Record<string, any>;
    const checkoutUrl = body.checkoutUrl ?? body.paymentUrl ?? body.data?.checkoutUrl;
    if (!checkoutUrl) throw new Error('Bancolombia no devolvió una URL de pago');
    return { checkoutUrl, providerPaymentId: body.id ?? body.data?.id, instructions: 'Paga en el enlace seguro de Bancolombia.' };
  }
}

/** Staff verifies the actual bank credit; no gateway call or automatic receipt claim. */
export class ManualTransferPaymentProvider implements PaymentProvider {
  readonly name = 'manual_transfer';
  constructor(private readonly cfg: Config) {}
  async createPayment(input: PaymentRequest) {
    return { instructions: `${this.cfg.MANUAL_TRANSFER_INSTRUCTIONS}\nValor: ${new Intl.NumberFormat('es-CO', {style:'currency',currency:'COP',maximumFractionDigits:0}).format(input.amountCop)}\nReferencia: ${input.reference}\nEl equipo verificará el abono en la cuenta antes de confirmar el pedido.` };
  }
}

/** No gateway or advance payment: the balance is collected at delivery. */
export class CashOnDeliveryPaymentProvider implements PaymentProvider {
  readonly name = 'cash_on_delivery';
  async createPayment(_input: PaymentRequest) {
    return { instructions: 'Pago contra entrega.' };
  }
}
