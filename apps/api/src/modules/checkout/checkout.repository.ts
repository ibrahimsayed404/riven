import { Injectable } from '@nestjs/common';
import { Cart, CartItem, OrderGroup, Order, OrderItem, Prisma, Product, ProductVariant } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { fromCents } from '../../common/money';
import { PUBLIC_PRODUCT_WHERE } from '../products/product-visibility';

export type CartForCheckout = Cart & {
  items: (CartItem & { product: Product; variant: ProductVariant })[];
};

export type OrderGroupWithOrders = OrderGroup & { orders: (Order & { items: OrderItem[] })[] };

export interface OrderDraft {
  vendorId: string;
  subtotalCents: number;
  items: {
    productId: string;
    variantId: string;
    titleSnapshot: string;
    priceSnapshotCents: number;
    quantity: number;
  }[];
}

/** Thrown inside the checkout transaction so the whole thing rolls back. */
export class OutOfStockError extends Error {
  constructor(public readonly variantId: string) {
    super(`Variant ${variantId} out of stock`);
    this.name = 'OutOfStockError';
  }
}

/**
 * Every Prisma call for checkout and the Paymob webhook (fix.js ARCH-01).
 * Stock is reserved here (decrement at order creation) and released by
 * OrdersRepository.cancelPendingGroup — the two halves of one reservation.
 */
@Injectable()
export class CheckoutRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCartWithItems(userId: string): Promise<CartForCheckout | null> {
    return this.prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true } } },
    });
  }

  /** Which of these products a shopper may still buy — same rule as the public catalogue. */
  async findPurchasableProductIds(productIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.product.findMany({
      where: { id: { in: productIds }, ...PUBLIC_PRODUCT_WHERE },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /**
   * One Serializable transaction: group + per-vendor orders + snapshots, stock
   * decrement with a negative check (throws OutOfStockError to roll back), and
   * the cart cleared. Prices arrive as integer piastres and are stored as Decimal.
   */
  createOrderGroup(input: {
    userId: string;
    cartId: string;
    orders: OrderDraft[];
  }): Promise<OrderGroupWithOrders> {
    return this.prisma.$transaction(
      async (tx) => {
        const group = await tx.orderGroup.create({ data: { userId: input.userId } });

        const orders = [];
        for (const draft of input.orders) {
          const order = await tx.order.create({
            data: {
              orderGroupId: group.id,
              vendorId: draft.vendorId,
              userId: input.userId,
              status: 'PENDING',
              subtotal: fromCents(draft.subtotalCents),
              items: {
                create: draft.items.map((item) => ({
                  productId: item.productId,
                  variantId: item.variantId,
                  titleSnapshot: item.titleSnapshot,
                  priceSnapshot: fromCents(item.priceSnapshotCents),
                  quantity: item.quantity,
                })),
              },
            },
            include: { items: true },
          });
          orders.push(order);
        }

        for (const draft of input.orders) {
          for (const item of draft.items) {
            const updated = await tx.productVariant.update({
              where: { id: item.variantId },
              data: { stockQuantity: { decrement: item.quantity } },
              select: { stockQuantity: true },
            });
            if (updated.stockQuantity < 0) {
              throw new OutOfStockError(item.variantId);
            }
          }
        }

        await tx.cartItem.deleteMany({ where: { cartId: input.cartId } });

        return { ...group, orders };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  setPaymobIntent(groupId: string, intent: { intentId: string; paymobOrderId: string | null }): Promise<OrderGroup> {
    return this.prisma.orderGroup.update({
      where: { id: groupId },
      data: { paymobIntentId: intent.intentId, paymobOrderId: intent.paymobOrderId },
    });
  }

  findGroupWithOrders(groupId: string): Promise<OrderGroupWithOrders | null> {
    return this.prisma.orderGroup.findUnique({
      where: { id: groupId },
      include: { orders: { include: { items: true } } },
    });
  }

  /**
   * Webhook lookup by the id Paymob signs as `order.id`, against the Paymob
   * order id stored at intent creation or (older rows) the intention id. Never
   * by an unsigned field (fix.js PAY-02), and never by the transaction id —
   * transaction ids and intention ids are different Paymob sequences and a
   * coincidental collision would attribute money to the wrong group.
   */
  findGroupByPaymobOrderId(paymobOrderId: string): Promise<OrderGroupWithOrders | null> {
    return this.prisma.orderGroup.findFirst({
      where: { OR: [{ paymobOrderId }, { paymobIntentId: paymobOrderId }] },
      include: { orders: { include: { items: true } } },
    });
  }

  /**
   * Records the FIRST Paymob transaction seen for a group and, when the amount
   * was right, moves every still-PENDING order to PAID — in one transaction.
   *
   * The write is guarded on `paymobTransactionId IS NULL`: a group carries at
   * most one transaction, so a replay (same id) or a second charge (different
   * id) both come back as `recorded: false` and the caller decides which it
   * was by comparing ids. Overwriting would erase the evidence of a double
   * charge. `paidAt` is set only when orders actually moved to PAID.
   */
  recordPayment(input: {
    groupId: string;
    transactionId: string;
    amountCents: number;
    markPaid: boolean;
  }): Promise<{ recorded: boolean; paidOrders: number }> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.orderGroup.updateMany({
        where: { id: input.groupId, paymobTransactionId: null },
        data: {
          paymobTransactionId: input.transactionId,
          paidAmountCents: input.amountCents,
          paidAt: input.markPaid ? new Date() : null,
        },
      });
      if (claimed.count === 0) return { recorded: false, paidOrders: 0 };

      if (!input.markPaid) return { recorded: true, paidOrders: 0 };

      const result = await tx.order.updateMany({
        where: { orderGroupId: input.groupId, status: 'PENDING' },
        data: { status: 'PAID' },
      });
      return { recorded: true, paidOrders: result.count };
    });
  }
}
