import { Body, Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { PaymobWebhookDispatcher } from './paymob-webhook.dispatcher';

/**
 * The one Paymob callback URL (fix.js PLAN-02). Transport only: hands the body
 * and the signature — which Paymob may send as an `hmac` header or `?hmac=`
 * query parameter — to the dispatcher. 200 for every acknowledged event,
 * including ones no handler wanted, so Paymob does not retry forever.
 */
@Controller('webhooks/paymob')
export class PaymobWebhookController {
  constructor(private readonly dispatcher: PaymobWebhookDispatcher) {}

  // Paymob retries aggressively; the HMAC is the gate here, not the rate limit.
  @SkipThrottle()
  @Post()
  @HttpCode(200)
  handleWebhook(
    @Body() payload: unknown,
    @Headers('hmac') hmacHeader?: string,
    @Query('hmac') hmacQuery?: string,
  ) {
    return this.dispatcher.dispatch(payload, hmacHeader || hmacQuery);
  }
}
