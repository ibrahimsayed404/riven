import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface PaymobIntent {
  intentId: string;
  /** Paymob's own order id for this intention — the id it signs in webhooks. */
  paymobOrderId: string | null;
  clientUrl: string | undefined;
}

/**
 * The classic Paymob HMAC covers exactly these keys, in this order. Anything
 * not on this list (special_reference, merchant_order_id, …) is unsigned and
 * must never be used to decide what to mark as paid (fix.js PAY-02).
 */
export const PAYMOB_HMAC_KEYS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

/**
 * Upper bound on the intention call. Node applies no default timeout to fetch,
 * and a stalled Paymob leaves POST /checkout hanging with stock already
 * reserved; the caller's catch turns a failure into paymentSetupFailed.
 */
const INTENTION_TIMEOUT_MS = 10_000;

@Injectable()
export class PaymobService {
  private readonly logger = new Logger(PaymobService.name);
  private readonly hmacSecret: string;
  private readonly integrationId: string;
  private readonly apiKey: string;
  private readonly baseUrl = 'https://accept.paymob.com/v1/intention';

  constructor(private readonly configService: ConfigService) {
    // Validated as optional at boot (env.validation.ts); absent in dev.
    this.hmacSecret = this.configService.get<string>('PAYMOB_HMAC_SECRET') || '';
    this.integrationId = this.configService.get<string>('PAYMOB_INTEGRATION_ID') || '';
    this.apiKey = this.configService.get<string>('PAYMOB_API_KEY') || '';
  }

  /**
   * Creates a payment intention in Paymob.
   *
   * @param amountCents Integer piastres — callers never pass EGP floats (fix.js PAY-04).
   * @param reference   Our OrderGroup id; Paymob echoes it as special_reference, which is NOT signed.
   */
  async createIntention(amountCents: number, reference: string): Promise<PaymobIntent> {
    if (!this.apiKey || !this.integrationId) {
      // Missing credentials is a deployment state, not a crash: 503 so clients
      // and monitors can tell "payments off" from a genuine 500.
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_NOT_CONFIGURED',
        message: 'Paymob credentials are not configured.',
      });
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new InternalServerErrorException({
        code: 'INVALID_AMOUNT',
        message: 'Payment amount must be a positive integer number of piastres.',
      });
    }

    const payload = {
      amount: amountCents,
      currency: 'EGP',
      payment_methods: [parseInt(this.integrationId, 10)],
      special_reference: reference,
      // billing_data / items can be added here if the Unified API requires them.
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(INTENTION_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Paymob Intention API failed: ${response.statusText} - ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();

      return {
        intentId: String(data.id),
        // The unified API reports the Paymob order created for the intention; that
        // order id is what the webhook signs (`order.id`), so it is our matching key.
        // Field name unverified against a real sandbox response — see fix.js PAY-02.
        paymobOrderId: data.intention_order_id != null ? String(data.intention_order_id) : null,
        clientUrl: data.client_url, // Or whatever the unified API returns for the client redirect/iframe
      };
    } catch (error) {
      this.logger.error('Paymob createIntention failed', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  /**
   * Verifies the HMAC Paymob sends with a webhook (classic lexicographic
   * concatenation of PAYMOB_HMAC_KEYS, SHA-512). Constant-time comparison after
   * a length check. Returns false when no secret is configured.
   *
   * @param payload    The parsed JSON body.
   * @param hmacValue  The signature, from the `hmac` header or `?hmac=` query.
   */
  verifyWebhookHmac(payload: any, hmacValue: string): boolean {
    if (!this.hmacSecret) {
      return false; // Fail securely if no secret is configured
    }

    // Classic webhook payloads nest the transaction under `obj`.
    const obj = payload?.obj || payload;

    let concatenatedString = '';

    for (const key of PAYMOB_HMAC_KEYS) {
      let value: unknown = obj;
      for (const part of key.split('.')) {
        if (value && typeof value === 'object') {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }

      if (typeof value === 'boolean') {
        concatenatedString += value ? 'true' : 'false';
      } else if (value !== undefined && value !== null) {
        concatenatedString += String(value);
      }
    }

    const expectedHash = crypto.createHmac('sha512', this.hmacSecret).update(concatenatedString).digest('hex').toLowerCase();
    const actualHash = hmacValue ? hmacValue.toLowerCase() : '';

    if (expectedHash.length !== actualHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(actualHash));
  }
}
