import { Module } from '@nestjs/common';

import { PaymobModule } from '../../infra/paymob/paymob.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutRepository } from './checkout.repository';
import { CheckoutService } from './checkout.service';
import { OrderPaymentHandler } from './order-payment.handler';

// The Paymob webhook route lives in PaymobModule; this module only registers
// OrderPaymentHandler with its dispatcher (fix.js PLAN-02).
@Module({
  imports: [PaymobModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, CheckoutRepository, OrderPaymentHandler],
})
export class CheckoutModule {}
