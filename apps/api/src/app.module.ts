import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';

import { PrismaModule } from './infra/prisma/prisma.module';
import { validateEnv } from './infra/config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { ProductsModule } from './modules/products/products.module';

import { CartModule } from './modules/cart/cart.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymobModule } from './infra/paymob/paymob.module';
import { QueueModule } from './infra/queue/queue.module';
import { BazaarsModule } from './modules/bazaars/bazaars.module';
import { BoothsModule } from './modules/booths/booths.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { SocialModule } from './modules/social/social.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { MediaModule } from './modules/media/media.module';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '../../.env')],
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    VendorsModule,
    ProductsModule,
    CartModule,
    CheckoutModule,
    OrdersModule,
    PaymobModule,
    QueueModule,
    BazaarsModule,
    BoothsModule,
    DiscoveryModule,
    SocialModule,
    CategoriesModule,
    MediaModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
