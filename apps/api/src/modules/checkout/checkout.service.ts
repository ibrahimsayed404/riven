import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { toCents } from '../../common/money';
import { PaymobService } from '../../infra/paymob/paymob.service';
import { CartForCheckout, CheckoutRepository, OrderDraft, OutOfStockError } from './checkout.repository';
import { orderGroupReference } from './order-payment.handler';

export { OutOfStockError } from './checkout.repository';

const MAX_SERIALIZATION_RETRIES = 3;

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly checkoutRepository: CheckoutRepository,
    private readonly paymobService: PaymobService,
  ) {}

  async checkoutCart(userId: string) {
    let attempts = 0;

    while (attempts < MAX_SERIALIZATION_RETRIES) {
      try {
        return await this.executeCheckout(userId);
      } catch (error) {
        // Serializable isolation: a concurrent checkout on the same stock rows
        // aborts one side with P2034; that side simply re-reads and retries.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
          attempts++;
          if (attempts >= MAX_SERIALIZATION_RETRIES) {
            throw new InternalServerErrorException({
              code: 'CHECKOUT_CONTENDED',
              message: 'System is experiencing high load. Please try again later.',
            });
          }
          continue;
        }

        if (error instanceof OutOfStockError) {
          throw new BadRequestException({
            code: 'CHECKOUT_ITEM_UNAVAILABLE',
            message: 'An item ran out of stock during checkout.',
            details: { items: [{ variantId: error.variantId, reason: 'OUT_OF_STOCK' }] },
          });
        }

        throw error;
      }
    }

    throw new InternalServerErrorException({ code: 'CHECKOUT_FAILED', message: 'Checkout failed.' });
  }

  private async executeCheckout(userId: string) {
    const cart = await this.checkoutRepository.findCartWithItems(userId);
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException({ code: 'CART_EMPTY', message: 'Cart is empty.' });
    }

    this.assertAllAvailable(cart, await this.checkoutRepository.findPurchasableProductIds(cart.items.map((i) => i.productId)));

    const group = await this.checkoutRepository.createOrderGroup({
      userId,
      cartId: cart.id,
      orders: this.draftOrdersByVendor(cart),
    });

    const totalCents = group.orders.reduce((sum, order) => sum + toCents(order.subtotal), 0);

    try {
      const intent = await this.paymobService.createIntention(totalCents, orderGroupReference(group.id));
      await this.checkoutRepository.setPaymobIntent(group.id, {
        intentId: intent.intentId,
        paymobOrderId: intent.paymobOrderId,
      });
      return {
        ...group,
        paymobIntentId: intent.intentId,
        clientUrl: intent.clientUrl,
        paymentSetupFailed: false,
      };
    } catch (error) {
      // Orders exist and stock is reserved; the client can retry payment setup.
      this.logger.error(
        `Paymob intent creation failed for order group ${group.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { ...group, paymentSetupFailed: true };
    }
  }

  async retryPaymentSetup(userId: string, orderGroupId: string) {
    const group = await this.checkoutRepository.findGroupWithOrders(orderGroupId);
    if (!group) {
      throw new NotFoundException({ code: 'ORDER_GROUP_NOT_FOUND', message: 'Order group not found.' });
    }
    if (group.userId !== userId) {
      throw new ForbiddenException({ code: 'ORDER_GROUP_FORBIDDEN', message: 'Order group does not belong to you.' });
    }
    if (group.paymobIntentId) {
      throw new BadRequestException({
        code: 'PAYMENT_ALREADY_SET_UP',
        message: 'A payment intention already exists for this order group.',
      });
    }
    if (!group.orders.every((order) => order.status === 'PENDING')) {
      throw new BadRequestException({
        code: 'ORDER_GROUP_NOT_PENDING',
        message: 'Cannot set up payment for orders that are no longer pending.',
      });
    }

    const totalCents = group.orders.reduce((sum, order) => sum + toCents(order.subtotal), 0);
    const intent = await this.paymobService.createIntention(totalCents, orderGroupReference(group.id));
    await this.checkoutRepository.setPaymobIntent(group.id, {
      intentId: intent.intentId,
      paymobOrderId: intent.paymobOrderId,
    });

    return { paymobIntentId: intent.intentId, clientUrl: intent.clientUrl };
  }

  /** Every line must still be purchasable and in stock; report all failures at once. */
  private assertAllAvailable(cart: CartForCheckout, purchasable: Set<string>): void {
    const failed: { cartItemId: string; reason: 'PRODUCT_UNAVAILABLE' | 'OUT_OF_STOCK' }[] = [];

    for (const item of cart.items) {
      if (!purchasable.has(item.productId) || item.variant.deletedAt) {
        failed.push({ cartItemId: item.id, reason: 'PRODUCT_UNAVAILABLE' });
      } else if (item.quantity > item.variant.stockQuantity) {
        failed.push({ cartItemId: item.id, reason: 'OUT_OF_STOCK' });
      }
    }

    if (failed.length > 0) {
      throw new BadRequestException({
        code: 'CHECKOUT_ITEM_UNAVAILABLE',
        message: 'Some items in your cart are no longer available or out of stock.',
        details: { items: failed },
      });
    }
  }

  /** One order per vendor; all money in integer piastres (fix.js PAY-04). */
  private draftOrdersByVendor(cart: CartForCheckout): OrderDraft[] {
    const byVendor = new Map<string, OrderDraft>();

    for (const item of cart.items) {
      const priceCents = toCents(item.variant.priceOverride ?? item.product.basePrice);
      const draft = byVendor.get(item.product.vendorId) ?? { vendorId: item.product.vendorId, subtotalCents: 0, items: [] };
      draft.items.push({
        productId: item.productId,
        variantId: item.variantId,
        titleSnapshot: item.product.title,
        priceSnapshotCents: priceCents,
        quantity: item.quantity,
      });
      draft.subtotalCents += priceCents * item.quantity;
      byVendor.set(item.product.vendorId, draft);
    }

    return [...byVendor.values()];
  }
}
