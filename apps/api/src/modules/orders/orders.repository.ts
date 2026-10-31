import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { MONEY_TX_LIMITS, withRetryableTx } from '../../infra/prisma/retryable-tx';
import { MovementSource } from '../products/inventory-ledger';

/** `wait` for shopper / admin cancels; `skipLocked` for expiry runs. */
export type GroupLockMode = 'wait' | 'skipLocked';

export interface CancelGroupResult {
  /** released: ≥ 1 order cancelled and restocked · skipped: locked by someone else · notEligible: nothing to do */
  outcome: 'released' | 'skipped' | 'notEligible';
  cancelledOrderIds: string[];
}

// Bounds every cancel / expiry transaction (23 R0.4): a blocked lock or a slow
// statement ends the transaction instead of holding a group indefinitely.
const GROUP_LOCK_TIMEOUT = '5s';
const GROUP_STATEMENT_TIMEOUT = '15s';

/** The expiry eligibility rule, as a Prisma filter. One definition, used by the candidate query and the backlog. */
const STALE_PENDING_GROUP_WHERE = (olderThan: Date): Prisma.OrderGroupWhereInput => ({
  createdAt: { lt: olderThan },
  paymobTransactionId: null,
  orders: { some: { status: OrderStatus.PENDING }, none: { status: { not: OrderStatus.PENDING } } },
});

/** The same rule, re-checked in memory under the group lock (age never changes, so it is not re-checked). */
function isExpiryEligible(group: { paymobTransactionId: string | null; orders: { status: OrderStatus }[] }): boolean {
  return (
    group.paymobTransactionId === null &&
    group.orders.length > 0 &&
    group.orders.every((order) => order.status === OrderStatus.PENDING)
  );
}

/** Ascending key order — the same comparator checkout uses for its decrements, so both lock variants in one order. */
const byKey = ([a]: [string, number], [b]: [string, number]) => (a < b ? -1 : a > b ? 1 : 0);

// What a vendor gets to see about the shopper who placed an order: enough to
// contact them about fulfilment, nothing else. Shopper-facing queries don't
// include the user at all.
const SHOPPER_CONTACT_SELECT = { id: true, name: true, email: true, phone: true } as const;

// Admin list row: the order plus both parties, no items. /admin/* only.
const ADMIN_ORDER_ROW_INCLUDE = {
  vendor: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.OrderInclude;

// Admin detail adds the items and the group's payment record — the Paymob ids
// are for payment support and are exposed on this admin route only.
const ADMIN_ORDER_DETAIL_INCLUDE = {
  ...ADMIN_ORDER_ROW_INCLUDE,
  items: true,
  orderGroup: {
    select: {
      id: true,
      createdAt: true,
      paidAt: true,
      paidAmountCents: true,
      paymobOrderId: true,
      paymobIntentId: true,
      paymobTransactionId: true,
    },
  },
} satisfies Prisma.OrderInclude;

export type AdminOrderRow = Prisma.OrderGetPayload<{ include: typeof ADMIN_ORDER_ROW_INCLUDE }>;
export type AdminOrderDetail = Prisma.OrderGetPayload<{ include: typeof ADMIN_ORDER_DETAIL_INCLUDE }>;

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
   *
   * Lock order (specs/commerce/01 §4, 23 §11.2): the order_groups row first —
   * the payment webhook takes the same row first — then the group's orders by
   * id, then the variants in ascending id (checkout decrements in the same
   * order). Shopper and admin cancels wait for the group lock; expiry uses
   * SKIP LOCKED and reports the group as skipped. Isolation stays Serializable
   * (23 R0.2); serialization failures and deadlocks are retried.
   */
  cancelPendingGroup(
    orderGroupId: string,
    options: {
      lockMode?: GroupLockMode;
      requireExpiryEligibility?: boolean;
      /** Recorded on the RELEASE ledger rows (commerce/25 S3): who gave the stock back. */
      source: MovementSource;
      actorUserId?: string | null;
    },
  ): Promise<CancelGroupResult> {
    const lockMode = options.lockMode ?? 'wait';

    return withRetryableTx(() =>
      this.prisma.$transaction(
        async (tx): Promise<CancelGroupResult> => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${GROUP_LOCK_TIMEOUT}, true)`;
          await tx.$queryRaw`SELECT set_config('statement_timeout', ${GROUP_STATEMENT_TIMEOUT}, true)`;

          const locked =
            lockMode === 'skipLocked'
              ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "order_groups" WHERE "id" = ${orderGroupId} FOR UPDATE SKIP LOCKED`
              : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "order_groups" WHERE "id" = ${orderGroupId} FOR UPDATE`;
          if (locked.length === 0) {
            // Locked by someone else (expiry), or the group does not exist.
            return { outcome: lockMode === 'skipLocked' ? 'skipped' : 'notEligible', cancelledOrderIds: [] };
          }

          if (options.requireExpiryEligibility) {
            // Same rule as the candidate query, re-checked under the lock: a
            // payment may have been recorded or an order moved since selection.
            const group = await tx.orderGroup.findUnique({
              where: { id: orderGroupId },
              select: { paymobTransactionId: true, orders: { select: { status: true } } },
            });
            if (!group || !isExpiryEligible(group)) {
              return { outcome: 'notEligible', cancelledOrderIds: [] };
            }
          }

          const pending = await tx.order.findMany({
            where: { orderGroupId, status: OrderStatus.PENDING },
            include: { items: { select: { variantId: true, quantity: true } } },
            orderBy: { id: 'asc' },
          });

          const cancelledOrderIds: string[] = [];
          const restock = new Map<string, number>();
          for (const order of pending) {
            const moved = await tx.order.updateMany({
              where: { id: order.id, status: OrderStatus.PENDING },
              data: { status: OrderStatus.CANCELLED },
            });
            if (moved.count !== 1) continue; // raced with the webhook; leave it

            cancelledOrderIds.push(order.id);
            for (const item of order.items) {
              restock.set(item.variantId, (restock.get(item.variantId) ?? 0) + item.quantity);
            }
          }

          // One RELEASE ledger row per variant, in the same transaction as the restock.
          const movements: Prisma.InventoryMovementCreateManyInput[] = [];
          for (const [variantId, quantity] of [...restock].sort(byKey)) {
            const { stockQuantity } = await tx.productVariant.update({
              where: { id: variantId },
              data: { stockQuantity: { increment: quantity } },
              select: { stockQuantity: true },
            });
            movements.push({
              variantId,
              type: 'RELEASE',
              quantityDelta: quantity,
              quantityBefore: stockQuantity - quantity,
              quantityAfter: stockQuantity,
              orderGroupId,
              actorUserId: options.actorUserId ?? null,
              source: options.source,
            });
          }
          if (movements.length > 0) await tx.inventoryMovement.createMany({ data: movements });

          return { outcome: cancelledOrderIds.length > 0 ? 'released' : 'notEligible', cancelledOrderIds };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, ...MONEY_TX_LIMITS },
      ),
      // Serializable + concurrent restocks of the same variant fail with 40001
      // under contention; a few more attempts keep cancels from surfacing them.
      { attempts: 5 },
    );
  }

  /**
   * Abandoned checkouts: groups created before `olderThan` whose orders are all
   * still PENDING and that have no recorded Paymob transaction — the same
   * filter as before R0 (application-clock cutoff, 23 §11.7), read in
   * `(createdAt, id)` order after an in-memory keyset cursor.
   */
  findStalePendingGroups(
    olderThan: Date,
    take: number,
    after?: { createdAt: Date; id: string },
  ): Promise<{ id: string; createdAt: Date }[]> {
    return this.prisma.orderGroup.findMany({
      where: {
        AND: [
          STALE_PENDING_GROUP_WHERE(olderThan),
          after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {},
        ],
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  /** Backlog snapshot for the run record: how many groups are eligible now, and the oldest one. */
  async staleBacklog(olderThan: Date): Promise<{ count: number; oldestCreatedAt: Date | null }> {
    const where = STALE_PENDING_GROUP_WHERE(olderThan);
    const [count, oldest] = await this.prisma.$transaction([
      this.prisma.orderGroup.count({ where }),
      this.prisma.orderGroup.findFirst({ where, select: { createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    return { count, oldestCreatedAt: oldest?.createdAt ?? null };
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

  // --- Admin (specs/admin-module-spec2.md A5): global reads, no user/vendor scope ---

  async findManyForAdmin(params: {
    status?: OrderStatus;
    vendorId?: string;
    userId?: string;
    orderGroupId?: string;
    page: number;
    limit: number;
  }): Promise<{ data: AdminOrderRow[]; total: number }> {
    const where: Prisma.OrderWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.vendorId) where.vendorId = params.vendorId;
    if (params.userId) where.userId = params.userId;
    if (params.orderGroupId) where.orderGroupId = params.orderGroupId;

    const [total, data] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ADMIN_ORDER_ROW_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);
    return { data, total };
  }

  findByIdForAdmin(orderId: string): Promise<AdminOrderDetail | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: ADMIN_ORDER_DETAIL_INCLUDE,
    });
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
