import { Controller, Post, Body, Headers, UnauthorizedException, HttpCode } from '@nestjs/common';
import { PaymobService } from '../../infra/paymob/paymob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Controller('webhooks/paymob')
export class PaymobWebhookController {
  constructor(
    private readonly paymobService: PaymobService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Body() payload: any,
    @Headers('hmac') hmacHeader: string,
  ) {
    if (!hmacHeader) {
      throw new UnauthorizedException('Missing HMAC signature');
    }

    const isValid = this.paymobService.verifyWebhookHmac(payload, hmacHeader);
    if (!isValid) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    // The legacy Paymob API wraps payload in "obj", while unified might not. 
    const eventObj = payload.obj || payload;
    
    // Check if this is a success event
    if (eventObj.success === true || payload.type === 'TRANSACTION_SUCCESS') {
      
      /**
       * [WARNING: HIGHEST RISK UNVERIFIED ASSUMPTION]
       * 
       * ID MATCHING:
       * The intention API returns an 'id' that we store as `paymobIntentId`.
       * However, Paymob webhooks traditionally send 'order.id' or 'id' which refer to 
       * the underlying Transaction or Order object, not necessarily the Intention ID.
       * 
       * If this happens, `intentId` here will NOT match `OrderGroup.paymobIntentId` and 
       * webhooks will silently fail to find the group.
       * 
       * MITIGATION:
       * 1. We also attempt to match against `special_reference` or `merchant_order_id` if present,
       *    since we explicitly pass `OrderGroup.id` as `special_reference` during creation.
       * 2. Once sandbox testing begins, inspect the raw payload here and adjust this matching logic.
       */
      const intentId = eventObj.order?.id?.toString() || eventObj.id?.toString();
      const specialReference = eventObj.special_reference?.toString() || eventObj.order?.merchant_order_id?.toString();
      
      if (!intentId && !specialReference) {
        console.warn('Paymob Webhook Error: Payload missing identifiable IDs', eventObj);
        return { received: true }; 
      }

      await this.prisma.$transaction(async (tx) => {
        // Attempt to find by intent ID first, fallback to checking if specialReference matches our internal OrderGroup ID
        const orderGroup = await tx.orderGroup.findFirst({
          where: { 
            OR: [
              { paymobIntentId: intentId || 'non-existent-fallback' },
              { id: specialReference || 'non-existent-fallback' },
            ]
          },
          include: { orders: true },
        });

        if (!orderGroup) {
          console.warn(`Paymob Webhook Error: OrderGroup not found for intentId: ${intentId} / specialReference: ${specialReference}`);
          return; 
        }

        // Idempotency: if already paid, do nothing
        const isAlreadyPaid = orderGroup.orders.some(o => o.status !== 'PENDING');
        if (isAlreadyPaid) {
          return; 
        }

        // AMOUNT CHECK
        // Paymob sends amount in cents/piastres
        const expectedTotalEgp = orderGroup.orders.reduce((sum, order) => sum + Number(order.subtotal), 0);
        const expectedTotalCents = Math.round(expectedTotalEgp * 100);
        const paidAmountCents = eventObj.amount_cents || (eventObj.order && eventObj.order.amount_cents) || 0;

        if (paidAmountCents !== expectedTotalCents) {
          console.error(`Paymob Webhook Error: Amount mismatch! Expected: ${expectedTotalCents} cents, Received: ${paidAmountCents} cents. OrderGroup ID: ${orderGroup.id}`);
          // Refuse to mark as PAID. A human will need to investigate.
          return; 
        }

        // Update all associated orders to PAID
        await tx.order.updateMany({
          where: { orderGroupId: orderGroup.id },
          data: { status: 'PAID' },
        });
      });
    }
    
    // Paymob expects a 200 OK regardless of event type to acknowledge receipt
    return { received: true };
  }
}
