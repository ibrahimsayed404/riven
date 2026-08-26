import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProductsRepository } from '../products/products.repository';
import { Prisma } from '@prisma/client';

export class OutOfStockError extends Error {
  constructor(public readonly variantId: string) {
    super(`Variant ${variantId} out of stock`);
    this.name = 'OutOfStockError';
  }
}

import { PaymobService } from '../../infra/paymob/paymob.service';

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsRepo: ProductsRepository,
    private readonly paymobService: PaymobService,
  ) {}

  async checkoutCart(userId: string) {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        return await this.executeCheckoutTransaction(userId);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' // Transaction failed due to a write conflict or a deadlock.
        ) {
          attempts++;
          if (attempts >= maxAttempts) {
            throw new InternalServerErrorException('System is experiencing high load. Please try again later.');
          }
          // Optional: Add small delay here before retrying if needed
          continue;
        }
        
        if (error instanceof OutOfStockError) {
          throw new BadRequestException({
            code: 'CHECKOUT_ITEM_UNAVAILABLE',
            message: 'An item ran out of stock during checkout.',
          });
        }

        // If it's another BadRequestException (from pre-transaction validation)
        if (error instanceof BadRequestException) {
          throw error;
        }

        // Re-throw the original error to avoid hiding real bugs
        throw error;
      }
    }
    
    throw new InternalServerErrorException('Checkout failed');
  }

  private async executeCheckoutTransaction(userId: string) {
    // 1. Fetch cart fresh
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: true,
            variant: true,
          },
        },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // 2. Validate items
    const failedItems: { cartItemId: string; reason: string }[] = [];

    // Pre-fetch visibility check (we need to know if products are still valid)
    const visibleProducts = await this.prisma.product.findMany({
      where: {
        id: { in: cart.items.map(i => i.productId) },
        ...this.productsRepo.visibilityFilter,
      },
      select: { id: true },
    });
    
    const visibleProductIds = new Set(visibleProducts.map(p => p.id));

    for (const item of cart.items) {
      if (!visibleProductIds.has(item.productId)) {
        failedItems.push({ cartItemId: item.id, reason: 'PRODUCT_UNAVAILABLE' });
        continue;
      }
      
      // Stock check
      if (item.quantity > item.variant.stockQuantity) {
        failedItems.push({ cartItemId: item.id, reason: 'OUT_OF_STOCK' });
      }
    }

    if (failedItems.length > 0) {
      throw new BadRequestException({
        code: 'CHECKOUT_ITEM_UNAVAILABLE',
        message: 'Some items in your cart are no longer available or out of stock.',
        items: failedItems,
      });
    }

    // 3. Group by vendorId
    const itemsByVendor = new Map<string, typeof cart.items>();
    for (const item of cart.items) {
      const vendorId = item.product.vendorId;
      if (!itemsByVendor.has(vendorId)) {
        itemsByVendor.set(vendorId, []);
      }
      itemsByVendor.get(vendorId)!.push(item);
    }

    // Prepare operations for the transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 4. Create OrderGroup
      const orderGroup = await tx.orderGroup.create({
        data: {
          userId,
        },
      });

      // 5. Create Orders per vendor
      const createdOrders = [];
      for (const [vendorId, items] of itemsByVendor.entries()) {
        const subtotal = items.reduce((sum, item) => {
          const price = Number(item.variant.priceOverride ?? item.product.basePrice);
          return sum + (price * item.quantity);
        }, 0);

        const order = await tx.order.create({
          data: {
            orderGroupId: orderGroup.id,
            vendorId,
            userId,
            status: 'PENDING',
            subtotal,
            items: {
              create: items.map(item => ({
                productId: item.productId,
                variantId: item.variantId,
                titleSnapshot: item.product.title,
                priceSnapshot: item.variant.priceOverride ?? item.product.basePrice,
                quantity: item.quantity,
              })),
            },
          },
          include: {
            items: true,
          },
        });
        createdOrders.push(order);
      }

      // 6. Decrement stock
      for (const item of cart.items) {
        const updatedVariant = await tx.productVariant.update({
          where: { id: item.variantId },
          data: {
            stockQuantity: {
              decrement: item.quantity,
            },
          },
          select: { stockQuantity: true },
        });

        // Concurrency safety check: if stock goes negative, throw to rollback
        if (updatedVariant.stockQuantity < 0) {
          throw new OutOfStockError(item.variantId);
        }
      }

      // 7. Clear cart
      await tx.cartItem.deleteMany({
        where: { cartId: cart.id },
      });

      return {
        ...orderGroup,
        orders: createdOrders,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    // 8. Attempt Paymob intention creation
    const totalAmount = result.orders.reduce((sum, order) => sum + Number(order.subtotal), 0);
    
    try {
      const paymobResult = await this.paymobService.createIntention(totalAmount, result.id);
      
      // Update OrderGroup with intention ID
      await this.prisma.orderGroup.update({
        where: { id: result.id },
        data: { paymobIntentId: paymobResult.intentId.toString() },
      });

      return {
        ...result,
        paymobIntentId: paymobResult.intentId.toString(),
        clientUrl: paymobResult.clientUrl,
        paymentSetupFailed: false,
      };
    } catch (error) {
      console.error('Paymob intent creation failed after successful checkout:', error);
      // Return order group but signal that payment setup failed
      return {
        ...result,
        paymentSetupFailed: true,
      };
    }
  }

  async retryPaymentSetup(userId: string, orderGroupId: string) {
    const orderGroup = await this.prisma.orderGroup.findUnique({
      where: { id: orderGroupId },
      include: { orders: true },
    });

    if (!orderGroup) {
      throw new BadRequestException('Order group not found');
    }

    if (orderGroup.userId !== userId) {
      throw new BadRequestException('Order group does not belong to this user');
    }

    if (orderGroup.paymobIntentId) {
      throw new BadRequestException('Payment intention already exists for this order group');
    }

    // Ensure orders are still PENDING
    const allPending = orderGroup.orders.every(o => o.status === 'PENDING');
    if (!allPending) {
      throw new BadRequestException('Cannot retry payment for orders that are not PENDING');
    }

    const totalAmount = orderGroup.orders.reduce((sum, order) => sum + Number(order.subtotal), 0);
    
    const paymobResult = await this.paymobService.createIntention(totalAmount, orderGroup.id);
    
    await this.prisma.orderGroup.update({
      where: { id: orderGroup.id },
      data: { paymobIntentId: paymobResult.intentId.toString() },
    });

    return {
      paymobIntentId: paymobResult.intentId.toString(),
      clientUrl: paymobResult.clientUrl,
    };
  }
}
