import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { PaymobWebhookController } from './paymob-webhook.controller';
import { CheckoutService } from './checkout.service';
import { ProductsModule } from '../products/products.module';
import { PaymobModule } from '../../infra/paymob/paymob.module';

@Module({
  imports: [ProductsModule, PaymobModule],
  controllers: [CheckoutController, PaymobWebhookController],
  providers: [CheckoutService],
})
export class CheckoutModule {}
