import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IdempotencyKey, IdempotencyStatus } from '@prisma/client';

import { toCents } from '../../common/money';
import { PaymobService } from '../../infra/paymob/paymob.service';
import { isContentionError } from '../../infra/prisma/retryable-tx';
import {
  CartChangedError,
  CartForCheckout,
  CheckoutRepository,
  IdempotencyKeyLostError,
  OrderDraft,
  OrderGroupWithOrders,
  OutOfStockError,
} from './checkout.repository';
import { orderGroupReference } from './order-payment.handler';

export { OutOfStockError } from './checkout.repository';

const MAX_SERIALIZATION_RETRIES = 3;

/**
 * No new checkout attempt starts after this (commerce/25 §12). The last attempt
 * is itself bounded (15 s transaction) and the Paymob call by 10 s, so a
 * request always finishes inside IDEMPOTENCY_LOCK_MS and a client retry with
 * the same key can never take the key over from a request still running.
 */
const CHECKOUT_BUDGET_MS = 20_000;

/** What POST /checkout answers: the order group plus how payment setup went. */
export type CheckoutResult = OrderGroupWithOrders & { paymobIntentId?: string | null; clientUrl?: string; paymentSetupFailed: boolean };

// Idempotency-Key (specs/commerce/25 S4, TD-07: optional on this route).
const IDEMPOTENCY_SCOPE = 'checkout';
const IDEMPOTENCY_KEY_FORMAT = /^[A-Za-z0-9._:-]{8,128}$/;
/** How long a request holds its key (covers the transaction + the Paymob call, which times out at 10 s). */
const IDEMPOTENCY_LOCK_MS = 60_000;
/** How long a used key keeps answering with the same order. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

const keyInProgress = () =>
  new ConflictException({
    code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    message: 'A checkout with this Idempotency-Key is still being processed. Retry in a few seconds.',
  });

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly checkoutRepository: CheckoutRepository,
    private readonly paymobService: PaymobService,
  ) {}

  /**
   * POST /checkout. With an Idempotency-Key (commerce/25 S4) a retried request
   * — e.g. after a timeout that lost the first response — gets the SAME order
   * group back, never a second order or a second reservation. Without one,
   * behaviour is unchanged (old clients keep working).
   */
  async checkoutCart(userId: string, idempotencyKey?: string): Promise<CheckoutResult> {
    if (idempotencyKey === undefined) {
      return this.checkoutWithRetries(userId);
    }
    if (!IDEMPOTENCY_KEY_FORMAT.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8–128 characters: letters, digits, dot, underscore, colon or hyphen (a UUID works).',
      });
    }

    const held = await this.holdIdempotencyKey(userId, idempotencyKey);
    if ('replay' in held) return held.replay;

    try {
      const result = await this.checkoutWithRetries(userId, held.key.id);
      // Stored as the JSON the client receives (Decimals and dates as strings).
      await this.checkoutRepository.completeIdempotencyKey(held.key.id, 201, JSON.parse(JSON.stringify(result)));
      return result;
    } catch (error) {
      // No order was created (the link is written inside the order transaction):
      // free the key so the client can fix the cart and retry with it.
      await this.checkoutRepository.releaseIdempotencyKey(held.key.id, held.heldUntil);
      throw error;
    }
  }

  /** Either this request now holds the key, or the answer to replay. */
  private async holdIdempotencyKey(
    userId: string,
    key: string,
  ): Promise<{ key: IdempotencyKey; heldUntil: Date } | { replay: CheckoutResult }> {
    const now = Date.now();
    const claim = () =>
      this.checkoutRepository.claimIdempotencyKey({
        userId,
        scope: IDEMPOTENCY_SCOPE,
        key,
        lockedUntil: new Date(now + IDEMPOTENCY_LOCK_MS),
        expiresAt: new Date(now + IDEMPOTENCY_TTL_MS),
      });

    let { row, created } = await claim();
    if (created) return { key: row, heldUntil: row.lockedUntil };

    if (row.expiresAt.getTime() <= now) {
      await this.checkoutRepository.deleteExpiredIdempotencyKey(row.id);
      ({ row, created } = await claim());
      if (created) return { key: row, heldUntil: row.lockedUntil };
    }
    if (row.status === IdempotencyStatus.COMPLETED) {
      // The stored JSON of the first response (the same body the client would have received).
      return { replay: row.responseBody as unknown as CheckoutResult };
    }
    if (row.lockedUntil.getTime() > now) {
      // The first request is still running — possibly already past its commit
      // and waiting on Paymob. Answering from the order now would hand out a
      // half-finished response and invite a racing retry-payment (commerce/25 §10).
      throw keyInProgress();
    }
    if (row.orderGroupId) {
      // The order committed but the response was never stored (crash or lost
      // connection after commit, lock lapsed): answer from the order itself.
      return { replay: await this.replayFromGroup(row.orderGroupId) };
    }
    const heldUntil = new Date(now + IDEMPOTENCY_LOCK_MS);
    if (await this.checkoutRepository.takeOverStaleIdempotencyKey(row.id, heldUntil)) {
      return { key: row, heldUntil };
    }
    throw keyInProgress();
  }

  private async replayFromGroup(groupId: string): Promise<CheckoutResult> {
    const group = await this.checkoutRepository.findGroupWithOrders(groupId);
    if (!group) throw new InternalServerErrorException({ code: 'CHECKOUT_FAILED', message: 'Checkout failed.' });
    // No intention stored = payment setup did not finish; the client calls retry-payment.
    return {
      ...group,
      clientUrl: group.paymobClientUrl ?? undefined,
      paymentSetupFailed: group.paymobIntentId === null,
    };
  }

  private async checkoutWithRetries(userId: string, idempotencyKeyId?: string): Promise<CheckoutResult> {
    let attempts = 0;

    const deadline = Date.now() + CHECKOUT_BUDGET_MS;

    while (attempts < MAX_SERIALIZATION_RETRIES) {
      // Every attempt after the first — whatever made the previous one fail
      // (contention or a changed cart) — starts only before the deadline.
      if (attempts > 0 && Date.now() >= deadline) break;
      try {
        return await this.executeCheckout(userId, idempotencyKeyId, deadline);
      } catch (error) {
        // Contention that outlived the repository's own retries (serialization
        // failure, deadlock — P2034 or a raw-query 40P01 —, lock or transaction
        // timeout): re-read and try again, then a coded, retryable 503.
        if (isContentionError(error)) {
          attempts++;
          if (attempts >= MAX_SERIALIZATION_RETRIES || Date.now() >= deadline) {
            throw new ServiceUnavailableException({
              code: 'CHECKOUT_CONTENDED',
              message: 'Checkout is busy right now. Please try again in a moment.',
            });
          }
          continue;
        }

        if (error instanceof IdempotencyKeyLostError) {
          throw keyInProgress();
        }

        if (error instanceof CartChangedError) {
          // A parallel checkout of the same cart committed first (it took the
          // lines), or the cart changed: re-read — usually CART_EMPTY now.
          attempts++;
          continue;
        }

        throw error;
      }
    }

    throw new ServiceUnavailableException({ code: 'CHECKOUT_CONTENDED', message: 'Checkout is busy right now. Please try again in a moment.' });
  }

  private async executeCheckout(userId: string, idempotencyKeyId?: string, deadline?: number): Promise<CheckoutResult> {
    const cart = await this.checkoutRepository.findCartWithItems(userId);
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException({ code: 'CART_EMPTY', message: 'Cart is empty.' });
    }

    this.assertAllAvailable(cart, await this.checkoutRepository.findPurchasableProductIds(cart.items.map((i) => i.productId)));

    let group: OrderGroupWithOrders;
    try {
      group = await this.checkoutRepository.createOrderGroup({
        userId,
        cartId: cart.id,
        cartLines: cart.items.map((item) => ({ id: item.id, quantity: item.quantity })),
        orders: this.draftOrdersByVendor(cart),
        idempotencyKeyId,
        deadline,
      });
    } catch (error) {
      if (error instanceof OutOfStockError) {
        // Same shape as the pre-check: the cart lines that failed (commerce/25 §10).
        // Re-run the pre-check on fresh data first, so a product withdrawn
        // meanwhile is reported as PRODUCT_UNAVAILABLE, not OUT_OF_STOCK.
        const fresh = await this.checkoutRepository.findCartWithItems(userId);
        if (fresh && fresh.items.length > 0) {
          this.assertAllAvailable(fresh, await this.checkoutRepository.findPurchasableProductIds(fresh.items.map((i) => i.productId)));
        }
        throw new BadRequestException({
          code: 'CHECKOUT_ITEM_UNAVAILABLE',
          message: 'An item ran out of stock during checkout.',
          details: {
            items: cart.items
              .filter((item) => item.variantId === error.variantId)
              .map((item) => ({ cartItemId: item.id, variantId: item.variantId, reason: 'OUT_OF_STOCK' })),
          },
        });
      }
      throw error;
    }

    const totalCents = group.orders.reduce((sum, order) => sum + toCents(order.subtotal), 0);

    try {
      const intent = await this.paymobService.createIntention(totalCents, orderGroupReference(group.id));
      // Stored only if the group has none yet: a racing retry-payment cannot be overwritten.
      const stored = await this.checkoutRepository.attachPaymobIntent(group.id, {
        intentId: intent.intentId,
        paymobOrderId: intent.paymobOrderId,
        clientUrl: intent.clientUrl,
      });
      return {
        ...group,
        paymobIntentId: stored.paymobIntentId,
        clientUrl: stored.paymobClientUrl ?? undefined,
        paymentSetupFailed: stored.paymobIntentId === null,
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
    if (!group.orders.every((order) => order.status === 'PENDING')) {
      throw new BadRequestException({
        code: 'ORDER_GROUP_NOT_PENDING',
        message: 'Cannot set up payment for orders that are no longer pending.',
      });
    }
    if (group.paymobIntentId) {
      // An intention exists: hand its payment page back instead of creating a
      // second one the webhook could not match (commerce/25 §10; R25).
      return this.existingIntention(group.paymobIntentId, group.paymobClientUrl);
    }

    const totalCents = group.orders.reduce((sum, order) => sum + toCents(order.subtotal), 0);
    const intent = await this.paymobService.createIntention(totalCents, orderGroupReference(group.id));
    const stored = await this.checkoutRepository.attachPaymobIntent(group.id, {
      intentId: intent.intentId,
      paymobOrderId: intent.paymobOrderId,
      clientUrl: intent.clientUrl,
    });
    // Lost a race to another setup: the stored intention is the one to pay.
    return this.existingIntention(stored.paymobIntentId as string, stored.paymobClientUrl);
  }

  private existingIntention(paymobIntentId: string, clientUrl: string | null) {
    if (!clientUrl) {
      // Set up before the payment page was stored (older rows): nothing to hand back.
      throw new BadRequestException({
        code: 'PAYMENT_ALREADY_SET_UP',
        message: 'A payment intention already exists for this order group.',
      });
    }
    return { paymobIntentId, clientUrl };
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
