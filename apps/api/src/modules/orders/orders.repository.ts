import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

// What a vendor gets to see about the shopper who placed an order: enough to
// contact them about fulfilment, nothing else. Shopper-facing queries don't
// include the user at all.
const SHOPPER_CONTACT_SELECT = { id: true, name: true, email: true, phone: true } as const;

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findShopperOrders(userId: string, page: number, limit: number, status?: OrderStatus) {
    const where: Prisma.OrderWhereInput = { userId };
    if (status) {
      where.status = status;
    }

    // count + page in one transaction so meta.total matches the page (fix.js ROBUST-02).
    const [total, data] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { data, total };
  }

  async getShopperOrder(userId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: {
        id: orderId,
        userId,
      },
      include: {
        items: true,
      },
    });
  }

  async findVendorOrders(vendorId: string, page: number, limit: number, status?: OrderStatus) {
    const where: Prisma.OrderWhereInput = { vendorId };
    if (status) {
      where.status = status;
    }

    const [total, data] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: SHOPPER_CONTACT_SELECT } },
      }),
    ]);

    return { data, total };
  }

  async getVendorOrder(vendorId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: {
        id: orderId,
        vendorId,
      },
      include: {
        items: true,
        user: { select: SHOPPER_CONTACT_SELECT },
      },
    });
  }

  /**
   * Conditional transition: the write only happens if the row is still in
   * `from`. Returns null when it was not — the caller reports a conflict
   * instead of overwriting a state someone else (the payment webhook, another
   * request) just set (fix.js PAY-05).
   */
  async transitionOrderStatus(orderId: string, from: OrderStatus, to: OrderStatus): Promise<Order | null> {
    const result = await this.prisma.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to },
    });
    if (result.count === 0) return null;
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  }

  /**
   * Cancels every still-PENDING order in a group and gives their stock back,
   * in one transaction. The status guard on the update means a concurrent
   * payment cannot be undone here, and stock is restored exactly once per
   * order that actually moved (fix.js PAY-01, PAY-03).
   *
   * Stock lives on product_variants, which checkout also writes: reservation
   * (decrement at checkout) and release (here) are two halves of one operation
   * and deliberately share the same rows.
   */
  cancelPendingGroup(orderGroupId: string): Promise<{ cancelledOrderIds: string[] }> {
    return this.prisma.$transaction(
      async (tx) => {
        const pending = await tx.order.findMany({
          where: { orderGroupId, status: OrderStatus.PENDING },
          include: { items: { select: { variantId: true, quantity: true } } },
        });

        const cancelledOrderIds: string[] = [];
        for (const order of pending) {
          const moved = await tx.order.updateMany({
            where: { id: order.id, status: OrderStatus.PENDING },
            data: { status: OrderStatus.CANCELLED },
          });
          if (moved.count !== 1) continue; // raced with the webhook; leave it

          cancelledOrderIds.push(order.id);
          for (const item of order.items) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { stockQuantity: { increment: item.quantity } },
            });
          }
        }

        return { cancelledOrderIds };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Groups created before `olderThan` whose orders are all still PENDING — abandoned checkouts. */
  async findStalePendingGroupIds(olderThan: Date, take: number): Promise<string[]> {
    const rows = await this.prisma.orderGroup.findMany({
      where: {
        createdAt: { lt: olderThan },
        paymobTransactionId: null,
        orders: { some: { status: OrderStatus.PENDING }, none: { status: { not: OrderStatus.PENDING } } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take,
    });
    return rows.map((row) => row.id);
  }

  async hasDeliveredVendorOrder(userId: string, orderId: string, vendorId: string): Promise<boolean> {
    const count = await this.prisma.order.count({
      where: {
        id: orderId,
        userId,
        status: OrderStatus.DELIVERED,
        vendorId,
      },
    });
    return count > 0;
  }

  async hasDeliveredProductOrder(userId: string, orderId: string, productId: string): Promise<boolean> {
    const count = await this.prisma.orderItem.count({
      where: {
        orderId,
        productId,
        order: {
          userId,
          status: OrderStatus.DELIVERED,
        },
      },
    });
    return count > 0;
  }

  /** One GROUP BY, not one count per status. Orders have no soft-delete. */
  async groupByStatus(): Promise<{ status: OrderStatus; count: number }[]> {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }
}
