import { Module } from '@nestjs/common';

import { PaymobEventsRepository } from './paymob-events.repository';
import { PaymobEventsService } from './paymob-events.service';
import { PaymobWebhookController } from './paymob-webhook.controller';
import { PaymobWebhookDispatcher } from './paymob-webhook.dispatcher';
import { PaymobService } from './paymob.service';

// Owns the single webhook route. Domain modules import this module and
// register a PaymobWebhookHandler with the dispatcher on init.
@Module({
  controllers: [PaymobWebhookController],
  providers: [PaymobService, PaymobWebhookDispatcher, PaymobEventsRepository, PaymobEventsService],
  exports: [PaymobService, PaymobWebhookDispatcher, PaymobEventsService],
})
export class PaymobModule {}
