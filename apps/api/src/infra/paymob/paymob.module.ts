import { Module } from '@nestjs/common';

import { PaymobWebhookController } from './paymob-webhook.controller';
import { PaymobWebhookDispatcher } from './paymob-webhook.dispatcher';
import { PaymobService } from './paymob.service';

// Owns the single webhook route. Domain modules import this module and
// register a PaymobWebhookHandler with the dispatcher on init.
@Module({
  controllers: [PaymobWebhookController],
  providers: [PaymobService, PaymobWebhookDispatcher],
  exports: [PaymobService, PaymobWebhookDispatcher],
})
export class PaymobModule {}
