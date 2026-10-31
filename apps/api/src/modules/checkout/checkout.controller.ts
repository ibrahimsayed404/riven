import { Controller, Headers, Post, UseGuards, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CheckoutService } from './checkout.service';
import { Role } from '@prisma/client';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SHOPPER)
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  // Each checkout reserves stock for the pending TTL, so a scripted loop could
  // hold a product's whole stock; 10 a minute per user is far above any real
  // shopper and well below that.
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  // Optional Idempotency-Key header (specs/commerce/25 S4): a retry with the same
  // key returns the same order group instead of creating a second one.
  checkout(@CurrentUser('id') userId: string, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.checkoutService.checkoutCart(userId, idempotencyKey);
  }

  @Post(':orderGroupId/retry-payment')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  retryPayment(
    @CurrentUser('id') userId: string,
    @Param('orderGroupId') orderGroupId: string,
  ) {
    return this.checkoutService.retryPaymentSetup(userId, orderGroupId);
  }
}
