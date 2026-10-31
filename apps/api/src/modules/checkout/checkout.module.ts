import { Module } from '@nestjs/common';

import { PaymobModule } from '../../infra/paymob/paymob.module';
import { AuditModule } from '../audit/audit.module';
import { AdminPaymentExceptionsController } from './admin-payment-exceptions.controller';
import { CheckoutController } from './checkout.controller';
import { CheckoutRepository } from './checkout.repository';
import { CheckoutService } from './checkout.service';
import { OrderPaymentHandler } from './order-payment.handler';
import { PaymentExceptionsService } from './payment-exceptions.service';

// The Paymob webhook route lives in PaymobModule; this module only registers
// OrderPaymentHandler with its dispatcher (fix.js PLAN-02).
@Module({
  imports: [PaymobModule, AuditModule],
  controllers: [CheckoutController, AdminPaymentExceptionsController],
  providers: [CheckoutService, CheckoutRepository, OrderPaymentHandler, PaymentExceptionsService],
  exports: [PaymentExceptionsService],
})
export class CheckoutModule {}
