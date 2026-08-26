import { Controller, Post, UseGuards, Param } from '@nestjs/common';
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

  @Post()
  checkout(@CurrentUser('id') userId: string) {
    return this.checkoutService.checkoutCart(userId);
  }

  @Post(':orderGroupId/retry-payment')
  retryPayment(
    @CurrentUser('id') userId: string,
    @Param('orderGroupId') orderGroupId: string,
  ) {
    return this.checkoutService.retryPaymentSetup(userId, orderGroupId);
  }
}
