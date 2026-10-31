import { Body, Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

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

  // Paymob retries aggressively, so the limit is high; it only stops a replayed
  // signed body from being used to hammer the database (commerce/25 §10).
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
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
