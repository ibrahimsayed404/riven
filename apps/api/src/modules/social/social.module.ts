import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';

@Module({
  imports: [OrdersModule],
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
