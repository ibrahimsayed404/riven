import { Injectable } from '@nestjs/common';
import {
  Cart,
  CartItem,
  IdempotencyKey,
  IdempotencyStatus,
  OrderGroup,
  Order,
  OrderItem,
  PaymentExceptionStatus,
  PaymentExceptionType,
  Prisma,
  Product,
  ProductVariant,
} from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { MONEY_TX_LIMITS, withRetryableTx } from '../../infra/prisma/retryable-tx';
import { fromCents } from '../../common/money';
import { MOVEMENT_SOURCE } from '../products/inventory-ledger';
import { PUBLIC_PRODUCT_WHERE } from '../products/product-visibility';
import { decidePayment, PaymentDecision } from './payment-decision';

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

export type AppliedPayment = PaymentDecision & { paidOrders: number };

// Same bounds as the expiry / cancel paths that take the group lock (specs/commerce/23 R0.3).
const GROUP_LOCK_TIMEOUT = '5s';
const GROUP_STATEMENT_TIMEOUT = '15s';

/**
 * Checkout's own bounds (commerce/25 §12): every attempt is short (a blocked
 * row lock gives up after 5 s, a statement after 10 s, the transaction after
 * 15 s) and the caller passes an overall deadline, so a checkout — retries and
 * the Paymob call included — always ends well inside the 60 s idempotency lock.
 */
const CHECKOUT_LOCK_TIMEOUT = '5s';
const CHECKOUT_STATEMENT_TIMEOUT = '10s';
const CHECKOUT_TX_LIMITS = { maxWait: 5_000, timeout: 15_000 } as const;

const EXCEPTION_DETAIL: Record<PaymentExceptionType, string> = {
  DOUBLE_PAYMENT:
    'A second successful charge for an order group that had already recorded one. Not applied; the customer was likely charged twice — refund or investigate.',
  LATE_PAYMENT:
    'Charge arrived after the order group was cancelled or expired. Recorded, orders stay cancelled; refund or resolve manually (BD-17).',
  AMOUNT_MISMATCH:
    'Charged amount differs from the order group total. Not applied; the order group is unchanged (it still expires or can still be paid). Refund or investigate.',
  CURRENCY_MISMATCH:
    'Charge currency is missing or not EGP. Not applied; the order group is unchanged (it still expires or can still be paid). Refund or investigate.',
  UNMATCHED_PAYMENT: 'A signed, successful charge that matches no order group. Nobody received goods for it: refund or investigate with Paymob.',
};

const ADMIN_PAYMENT_EXCEPTION_SELECT = {
  id: true,
  type: true,
  status: true,
  orderGroupId: true,
  provider: true,
  providerTransactionId: true,
  amountCents: true,
  currency: true,
  expectedAmountCents: true,
  detail: true,
  createdAt: true,
  resolvedAt: true,
  resolutionNote: true,
  resolvedBy: { select: { id: true, name: true, email: true } },
  orderGroup: { select: { id: true, userId: true, createdAt: true, paymobTransactionId: true, paidAt: true } },
} satisfies Prisma.PaymentExceptionSelect;

export type AdminPaymentException = Prisma.PaymentExceptionGetPayload<{ select: typeof ADMIN_PAYMENT_EXCEPTION_SELECT }>;

/**
 * Thrown inside the checkout transaction when the cart lines it priced are no
 * longer exactly there (a parallel checkout of the same cart took them, or the
 * shopper changed the cart): rolls everything back; the service re-reads.
 */
export class CartChangedError extends Error {
  constructor() {
    super('Cart changed during checkout');
    this.name = 'CartChangedError';
  }
}

/** Thrown inside the checkout transaction when the idempotency key was taken over meanwhile; rolls everything back. */
export class IdempotencyKeyLostError extends Error {
  constructor() {
    super('Idempotency key no longer held by this request');
    this.name = 'IdempotencyKeyLostError';
  }
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
   * One READ COMMITTED transaction with guarded writes: the priced cart lines
   * removed (CartChangedError if they changed), group + per-vendor orders +
   * snapshots, and a conditional stock decrement per variant that also
   * re-checks the product is still public (OutOfStockError rolls everything
   * back). Prices arrive as integer piastres and are stored as Decimal.
   */
  createOrderGroup(input: {
    userId: string;
    cartId: string;
    /** The exact cart lines priced into `orders`; they are deleted in the transaction or it rolls back. */
    cartLines: { id: string; quantity: number }[];
    orders: OrderDraft[];
    /** commerce/25 S4: linked to the group in this transaction, so the key and the order commit together. */
    idempotencyKeyId?: string;
    /** Epoch ms after which no retry starts (the caller's checkout budget). */
    deadline?: number;
  }): Promise<OrderGroupWithOrders> {
    // READ COMMITTED (commerce/25 §10): every invariant here is a guarded
    // write — the conditional stock decrement, the exact cart-line delete, the
    // guarded key link — re-checked under row locks, so Serializable only
    // added serialization failures under contention. Deadlocks are retried.
    return withRetryableTx(() =>
      this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${CHECKOUT_LOCK_TIMEOUT}, true)`;
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${CHECKOUT_STATEMENT_TIMEOUT}, true)`;

        // FIRST, exactly the lines (and quantities) this checkout priced. A
        // double submit of the same cart blocks here on the first request's
        // row locks and, once it commits, finds fewer lines → CartChangedError
        // → the caller re-reads the cart (CART_EMPTY) instead of failing on
        // stock the first request just took. A line added meanwhile stays in
        // the cart for the next checkout.
        const removed = await tx.cartItem.deleteMany({
          where: { cartId: input.cartId, OR: input.cartLines.map((line) => ({ id: line.id, quantity: line.quantity })) },
        });
        if (removed.count !== input.cartLines.length) {
          throw new CartChangedError();
        }

        const group = await tx.orderGroup.create({ data: { userId: input.userId } });

        if (input.idempotencyKeyId) {
          const linked = await tx.idempotencyKey.updateMany({
            where: { id: input.idempotencyKeyId, status: IdempotencyStatus.IN_PROGRESS, orderGroupId: null },
            data: { orderGroupId: group.id },
          });
          if (linked.count !== 1) throw new IdempotencyKeyLostError();
        }

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

        // One decrement per variant, in ascending variant id — the order
        // OrdersRepository.cancelPendingGroup restocks in, so a checkout and a
        // cancel touching the same variants never wait on each other in a cycle
        // (specs/commerce/23 R0.10, §11.8).
        const decrements = new Map<string, number>();
        for (const draft of input.orders) {
          for (const item of draft.items) {
            decrements.set(item.variantId, (decrements.get(item.variantId) ?? 0) + item.quantity);
          }
        }
        // The decrement only applies while enough stock is left, so it never
        // trips the stockQuantity >= 0 CHECK (specs/commerce/25 S2), and only
        // while the product is still public (PUBLIC_PRODUCT_WHERE, re-checked
        // here against committed data, §11); no row returned means the units
        // are gone or the product was withdrawn. Each one is a RESERVE ledger
        // row with the exact before/after (S3).
        const ordered = [...decrements].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const movements: Prisma.InventoryMovementCreateManyInput[] = [];
        for (const [variantId, quantity] of ordered) {
          const rows = await tx.$queryRaw<{ stockQuantity: number }[]>`
            UPDATE "product_variants" pv SET "stockQuantity" = pv."stockQuantity" - ${quantity}
            WHERE pv."id" = ${variantId} AND pv."deletedAt" IS NULL AND pv."stockQuantity" >= ${quantity}
              AND EXISTS (
                SELECT 1 FROM "products" p JOIN "vendors" v ON v."id" = p."vendorId"
                WHERE p."id" = pv."productId" AND p."isActive" AND p."deletedAt" IS NULL
                  AND v."verified" AND v."deletedAt" IS NULL)
            RETURNING pv."stockQuantity"`;
          if (rows.length === 0) {
            throw new OutOfStockError(variantId);
          }
          const after = Number(rows[0].stockQuantity);
          movements.push({
            variantId,
            type: 'RESERVE',
            quantityDelta: -quantity,
            quantityBefore: after + quantity,
            quantityAfter: after,
            orderGroupId: group.id,
            actorUserId: input.userId,
            source: MOVEMENT_SOURCE.CHECKOUT,
          });
        }
        await tx.inventoryMovement.createMany({ data: movements });

        return { ...group, orders };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, ...CHECKOUT_TX_LIMITS },
      ),
      { deadline: input.deadline },
    );
  }

  /**
   * Stores a payment intention on the group only if it has none yet
   * (commerce/25 §10). Two racing setups (a replayed checkout and a
   * retry-payment, or two retries) cannot overwrite each other, so the
   * intention the shopper pays is always the one the webhook will match.
   * Returns whether ours was stored, and what the group holds now.
   */
  async attachPaymobIntent(
    groupId: string,
    intent: { intentId: string; paymobOrderId: string | null; clientUrl: string | undefined },
  ): Promise<{ attached: boolean; paymobIntentId: string | null; paymobClientUrl: string | null }> {
    const { count } = await this.prisma.orderGroup.updateMany({
      where: { id: groupId, paymobIntentId: null },
      data: { paymobIntentId: intent.intentId, paymobOrderId: intent.paymobOrderId, paymobClientUrl: intent.clientUrl ?? null },
    });
    const stored = await this.prisma.orderGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: { paymobIntentId: true, paymobClientUrl: true },
    });
    return { attached: count === 1, ...stored };
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
   * Applies one successful provider charge to an order group, atomically
   * (specs/commerce/25 S1). Takes the order_groups row lock FIRST — the lock
   * expiry and cancel take first — then decides on the group as it is now
   * (decidePayment) and writes the decision in the same transaction: the
   * group's first transaction id, PENDING → PAID, and any PaymentException.
   * So an exception exists exactly when its outcome committed, and a crash
   * before commit leaves nothing for the provider's retry to trip over.
   *
   * Never both PAID and CANCELLED: a cancel/expiry that committed first leaves
   * no PENDING order (→ orphan, LATE_PAYMENT); one that comes second sees the
   * recorded transaction and refuses.
   */
  applyPayment(input: {
    groupId: string;
    provider: string;
    transactionId: string;
    amountCents: number | null;
    currency: string | null;
  }): Promise<AppliedPayment> {
    return withRetryableTx(() =>
      this.prisma.$transaction(async (tx): Promise<AppliedPayment> => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${GROUP_LOCK_TIMEOUT}, true)`;
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${GROUP_STATEMENT_TIMEOUT}, true)`;
        await tx.$queryRaw`SELECT "id" FROM "order_groups" WHERE "id" = ${input.groupId} FOR UPDATE`;

        const group = await tx.orderGroup.findUniqueOrThrow({
          where: { id: input.groupId },
          select: { paymobTransactionId: true, orders: { select: { status: true, subtotal: true } } },
        });
        const decision = decidePayment(group, input);

        let paidOrders = 0;
        if (decision.claim && decision.markPaid) {
          await tx.orderGroup.update({
            where: { id: input.groupId },
            data: { paymobTransactionId: input.transactionId, paidAmountCents: input.amountCents ?? 0, paidAt: new Date() },
          });
          paidOrders = (
            await tx.order.updateMany({ where: { orderGroupId: input.groupId, status: 'PENDING' }, data: { status: 'PAID' } })
          ).count;
        }

        if (decision.exception) {
          // One exception per (type, provider transaction): a re-delivered
          // callback that reaches this point again adds nothing.
          await tx.paymentException.createMany({
            data: [
              {
                type: decision.exception,
                orderGroupId: input.groupId,
                provider: input.provider,
                providerTransactionId: input.transactionId,
                amountCents: input.amountCents ?? 0,
                currency: input.currency,
                expectedAmountCents: decision.expectedCents,
                detail: EXCEPTION_DETAIL[decision.exception],
              },
            ],
            skipDuplicates: true,
          });
        }

        return { ...decision, paidOrders };
      }, MONEY_TX_LIMITS),
    );
  }

  // ---------------------------------------------------------------- payment exceptions (admin)

  async findPaymentExceptionsForAdmin(params: {
    status?: PaymentExceptionStatus;
    type?: PaymentExceptionType;
    orderGroupId?: string;
    page: number;
    limit: number;
  }): Promise<{ data: AdminPaymentException[]; total: number }> {
    const where: Prisma.PaymentExceptionWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.type) where.type = params.type;
    if (params.orderGroupId) where.orderGroupId = params.orderGroupId;

    const [total, data] = await this.prisma.$transaction([
      this.prisma.paymentException.count({ where }),
      this.prisma.paymentException.findMany({
        where,
        select: ADMIN_PAYMENT_EXCEPTION_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);
    return { data, total };
  }

  findPaymentExceptionByIdForAdmin(id: string): Promise<AdminPaymentException | null> {
    return this.prisma.paymentException.findUnique({ where: { id }, select: ADMIN_PAYMENT_EXCEPTION_SELECT });
  }

  /**
   * OPEN → RESOLVED, guarded on the status so two admins can't both resolve it,
   * with its audit row in the SAME transaction (TD-03: financial actions are
   * audited inside the transaction, never best-effort). Returns rows moved.
   */
  resolvePaymentException(id: string, adminId: string, note: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentException.updateMany({
        where: { id, status: PaymentExceptionStatus.OPEN },
        data: { status: PaymentExceptionStatus.RESOLVED, resolvedAt: new Date(), resolvedById: adminId, resolutionNote: note },
      });
      if (count === 1) {
        await tx.adminAuditLog.create({
          data: { actorId: adminId, action: 'PAYMENT_EXCEPTION_RESOLVED', targetType: 'PAYMENT_EXCEPTION', targetId: id, reason: note },
        });
      }
      return count;
    });
  }

  /** A signed, successful charge no order group claimed (commerce/25 §10); one row per provider transaction. */
  async recordUnmatchedPayment(input: { provider: string; transactionId: string; amountCents: number | null; currency: string | null }): Promise<void> {
    await this.prisma.paymentException.createMany({
      data: [
        {
          type: PaymentExceptionType.UNMATCHED_PAYMENT,
          orderGroupId: null,
          provider: input.provider,
          providerTransactionId: input.transactionId,
          amountCents: input.amountCents ?? 0,
          currency: input.currency,
          detail: EXCEPTION_DETAIL.UNMATCHED_PAYMENT,
        },
      ],
      skipDuplicates: true,
    });
  }

  countOpenPaymentExceptions(): Promise<number> {
    return this.prisma.paymentException.count({ where: { status: PaymentExceptionStatus.OPEN } });
  }

  // ---------------------------------------------------------------- idempotency keys (commerce/25 S4)

  /** Inserts the key IN_PROGRESS, or returns the existing row for (user, scope, key). */
  async claimIdempotencyKey(input: {
    userId: string;
    scope: string;
    key: string;
    lockedUntil: Date;
    expiresAt: Date;
  }): Promise<{ row: IdempotencyKey; created: boolean }> {
    try {
      const row = await this.prisma.idempotencyKey.create({ data: input });
      return { row, created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const row = await this.prisma.idempotencyKey.findUniqueOrThrow({
        where: { userId_scope_key: { userId: input.userId, scope: input.scope, key: input.key } },
      });
      return { row, created: false };
    }
  }

  /** A crashed request that never created its order: take its key over once its lock has lapsed. */
  async takeOverStaleIdempotencyKey(id: string, lockedUntil: Date): Promise<boolean> {
    const { count } = await this.prisma.idempotencyKey.updateMany({
      where: { id, status: IdempotencyStatus.IN_PROGRESS, orderGroupId: null, lockedUntil: { lte: new Date() } },
      data: { lockedUntil },
    });
    return count === 1;
  }

  async completeIdempotencyKey(id: string, responseStatus: number, responseBody: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: { status: IdempotencyStatus.COMPLETED, responseStatus, responseBody },
    });
  }

  /**
   * The request failed before creating an order: free the key so a corrected
   * retry can use it — only while this request still holds it (its own
   * `lockedUntil`), never a key another request has taken over since.
   */
  async releaseIdempotencyKey(id: string, heldUntil: Date): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { id, status: IdempotencyStatus.IN_PROGRESS, orderGroupId: null, lockedUntil: heldUntil },
    });
  }

  /** A key past its expiry may be reused for a new request (its old order, if any, is untouched). */
  async deleteExpiredIdempotencyKey(id: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({ where: { id, expiresAt: { lte: new Date() } } });
  }
}
