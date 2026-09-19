import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { join } from 'node:path';

import { DomainEventsModule } from './common/events/domain-events.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';

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
import { SearchInfraModule } from './infra/search/search-infra.module';
import { BazaarsModule } from './modules/bazaars/bazaars.module';
import { BoothsModule } from './modules/booths/booths.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { SocialModule } from './modules/social/social.module';
import { SearchModule } from './modules/search/search.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { MediaModule } from './modules/media/media.module';
import { AuditModule } from './modules/audit/audit.module';
import { AdminModule } from './modules/admin/admin.module';

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
    // Global rate limit: generous default, tightened per route with @Throttle
    // (auth, location updates). Keyed by user when authenticated, else by IP.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    PrismaModule,
    DomainEventsModule,
    AuthModule,
    UsersModule,
    VendorsModule,
    ProductsModule,
    CartModule,
    CheckoutModule,
    OrdersModule,
    PaymobModule,
    QueueModule,
    SearchInfraModule,
    BazaarsModule,
    BoothsModule,
    DiscoveryModule,
    SocialModule,
    SearchModule,
    CategoriesModule,
    MediaModule,
    AuditModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
})
export class AppModule {}
