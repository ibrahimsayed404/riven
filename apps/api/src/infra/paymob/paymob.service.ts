import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class PaymobService {
  private readonly hmacSecret: string;
  private readonly integrationId: string;
  private readonly apiKey: string;
  private readonly baseUrl = 'https://accept.paymob.com/v1/intention';

  constructor(private readonly configService: ConfigService) {
    // These will be undefined without credentials, but we still inject them.
    this.hmacSecret = this.configService.get<string>('PAYMOB_HMAC_SECRET') || '';
    this.integrationId = this.configService.get<string>('PAYMOB_INTEGRATION_ID') || '';
    this.apiKey = this.configService.get<string>('PAYMOB_API_KEY') || '';
  }

  /**
   * Creates a payment intention in Paymob.
   * 
   * @param amountEgp The amount in EGP (e.g., 100.50). 
   * @param reference The internal OrderGroup ID or reference.
   * @returns An object containing the intent ID and the client secret/url.
   */
  async createIntention(amountEgp: number, reference: string) {
    if (!this.apiKey || !this.integrationId) {
      throw new InternalServerErrorException('Paymob credentials are not configured');
    }

    // Paymob expects the smallest currency unit (piastres) as an integer.
    const amountCents = Math.round(amountEgp * 100);

    const payload = {
      amount: amountCents,
      currency: 'EGP',
      payment_methods: [parseInt(this.integrationId, 10)],
      special_reference: reference,
      // You can add billing_data, items, etc. here if required by the Unified API.
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Paymob Intention API failed: ${response.statusText} - ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      
      return {
        intentId: data.id,
        clientUrl: data.client_url, // Or whatever the unified API returns for the client redirect/iframe
      };
    } catch (error) {
      console.error('Paymob createIntention error:', error);
      throw error;
    }
  }

  /**
   * Verifies the HMAC signature sent by Paymob in the webhook.
   * 
   * Note: The Unified Intention API webhook payload structure is not firmly documented.
   * We are implementing the classic Paymob lexicographical string concatenation here.
   * If the payload structure differs significantly in the new API (e.g. nested objects),
   * this logic will need adjustment. Alternatively, if Paymob adopts a standard raw-body 
   * HMAC calculation, this would change to hashing the raw HTTP string.
   * 
   * @param payload The parsed JSON payload from the webhook body.
   * @param hmacHeader The HMAC signature provided in the request header or query param.
   * @returns true if valid, false otherwise.
   */
  verifyWebhookHmac(payload: any, hmacHeader: string): boolean {
    if (!this.hmacSecret) {
      return false; // Fail securely if no secret is configured
    }

    // Paymob classic webhook payload is nested under 'obj' if it comes as { type: '...', obj: { ... } }
    const obj = payload.obj || payload;

    // The legacy list of keys sorted lexicographically
    const keys = [
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
    ];

    let concatenatedString = '';

    for (const key of keys) {
      // Handle nested keys like 'order.id'
      const keyParts = key.split('.');
      let value = obj;
      
      for (const part of keyParts) {
        if (value && typeof value === 'object') {
          value = value[part];
        } else {
          value = undefined;
          break;
        }
      }

      // Convert boolean true/false to "true"/"false" strings as Paymob expects string concatenation
      if (typeof value === 'boolean') {
        concatenatedString += value ? 'true' : 'false';
      } else if (value !== undefined && value !== null) {
        concatenatedString += value.toString();
      }
    }

    const hash = crypto
      .createHmac('sha512', this.hmacSecret)
      .update(concatenatedString)
      .digest('hex');

    const expectedHash = hash.toLowerCase();
    const actualHash = hmacHeader ? hmacHeader.toLowerCase() : '';

    if (expectedHash.length !== actualHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(expectedHash),
      Buffer.from(actualHash)
    );
  }
}
