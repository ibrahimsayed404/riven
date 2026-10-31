import { Injectable } from '@nestjs/common';

import { PaymobEventsRepository } from './paymob-events.repository';

/** How long a signed payment may stay unprocessed before monitoring calls it stuck. */
export const STUCK_PAYMENT_AFTER_MS = 15 * 60_000;

/** Read side of the stored Paymob callbacks, for monitoring (GET /health/maintenance). */
@Injectable()
export class PaymobEventsService {
  constructor(private readonly events: PaymobEventsRepository) {}

  countStuckPayments(now = new Date()): Promise<number> {
    return this.events.countStuckPayments(new Date(now.getTime() - STUCK_PAYMENT_AFTER_MS));
  }
}
