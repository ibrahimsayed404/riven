import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, RatingTargetType } from '@prisma/client';

import { pageMeta } from '../../common/dto/pagination-query.dto';
import { AdminOrderDetail, OrdersRepository } from './orders.repository';

// Valid forward transitions
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

const orderNotFound = () => new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found.' });

/** The row moved between our read and our write — the client should re-fetch. */
const orderStateChanged = () =>
  new ConflictException({
    code: 'ORDER_STATE_CHANGED',
    message: 'The order changed state while this request was in flight. Reload and try again.',
  });

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly ordersRepository: OrdersRepository) {}

  validateTransition(currentStatus: OrderStatus, newStatus: OrderStatus) {
    const allowed = ORDER_STATUS_TRANSITIONS[currentStatus];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException({
        code: 'INVALID_ORDER_TRANSITION',
        message: `Cannot transition order from ${currentStatus} to ${newStatus}. Allowed next states: ${allowed.join(', ') || 'none'}`,
      });
    }
  }

  async getShopperOrders(userId: string, page: number, limit: number, status?: OrderStatus) {
    const { data, total } = await this.ordersRepository.findShopperOrders(userId, page, limit, status);
    return { data, meta: pageMeta(total, page, limit) };
  }

  async getShopperOrder(userId: string, orderId: string) {
    const order = await this.ordersRepository.getShopperOrder(userId, orderId);
    if (!order) {
      throw orderNotFound();
    }
    return order;
  }

  /**
   * Cancel is group-level: one Paymob intention covers the whole checkout, so
   * the unit of cancel is the unit of payment (fix.js PAY-01). Every PENDING
   * order in the group is cancelled and its stock released (PAY-03). A
   * payment that still arrives for the group is recorded by the webhook as an
   * orphan for manual refund, never applied.
   */
  async cancelOrder(userId: string, orderId: string) {
    const order = await this.getShopperOrder(userId, orderId);

    if (order.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'ORDER_NOT_CANCELLABLE',
        message: 'Orders can only be cancelled before payment; contact support for a paid order.',
      });
    }

    const { cancelledOrderIds } = await this.ordersRepository.cancelPendingGroup(order.orderGroupId);
    if (!cancelledOrderIds.includes(order.id)) {
      // Paid (or cancelled) between our read and the guarded write.
      throw orderStateChanged();
    }

    const refreshed = await this.getShopperOrder(userId, orderId);
    return { ...refreshed, cancelledOrderIds };
  }

  async confirmDelivery(userId: string, orderId: string) {
    const order = await this.getShopperOrder(userId, orderId);

    if (order.status !== 'SHIPPED') {
      throw new BadRequestException({
        code: 'ORDER_NOT_SHIPPED',
        message: `Delivery can only be confirmed for SHIPPED orders. Current status is ${order.status}.`,
      });
    }

    this.validateTransition(order.status, 'DELIVERED');

    const updated = await this.ordersRepository.transitionOrderStatus(orderId, 'SHIPPED', 'DELIVERED');
    if (!updated) throw orderStateChanged();
    return updated;
  }

  async getVendorOrders(vendorId: string, page: number, limit: number, status?: OrderStatus) {
    const { data, total } = await this.ordersRepository.findVendorOrders(vendorId, page, limit, status);
    return { data, meta: pageMeta(total, page, limit) };
  }

  async getVendorOrder(vendorId: string, orderId: string) {
    const order = await this.ordersRepository.getVendorOrder(vendorId, orderId);
    if (!order) {
      throw orderNotFound();
    }
    return order;
  }

  async updateVendorOrderStatus(vendorId: string, orderId: string, newStatus: OrderStatus) {
    const order = await this.getVendorOrder(vendorId, orderId);

    // Vendor is only allowed to transition PAID->FULFILLED, FULFILLED->SHIPPED
    if (newStatus !== 'FULFILLED' && newStatus !== 'SHIPPED') {
      throw new BadRequestException({
        code: 'VENDOR_TRANSITION_NOT_ALLOWED',
        message: 'Vendors can only update status to FULFILLED or SHIPPED.',
      });
    }

    this.validateTransition(order.status, newStatus);

    const updated = await this.ordersRepository.transitionOrderStatus(orderId, order.status, newStatus);
    if (!updated) throw orderStateChanged();
    return updated;
  }

  /**
   * Abandoned checkouts: groups older than the TTL whose orders are all still
   * PENDING and that no payment has touched. Cancelling them releases the
   * stock they reserved (fix.js PAY-03). Called from the orders queue.
   */
  async expireStalePendingGroups(ttlMinutes: number, batchSize = 100): Promise<{ groups: number; orders: number }> {
    const olderThan = new Date(Date.now() - ttlMinutes * 60_000);
    const groupIds = await this.ordersRepository.findStalePendingGroupIds(olderThan, batchSize);

    let orders = 0;
    for (const groupId of groupIds) {
      const { cancelledOrderIds } = await this.ordersRepository.cancelPendingGroup(groupId);
      orders += cancelledOrderIds.length;
    }

    if (groupIds.length > 0) {
      this.logger.log(`Expired ${groupIds.length} abandoned checkout group(s), ${orders} order(s); stock released.`);
    }
    return { groups: groupIds.length, orders };
  }

  async verifyDeliveredPurchase(
    userId: string,
    orderId: string,
    targetType: RatingTargetType,
    targetId: string,
  ): Promise<boolean> {
    if (targetType === RatingTargetType.VENDOR) {
      return this.ordersRepository.hasDeliveredVendorOrder(userId, orderId, targetId);
    }
    if (targetType === RatingTargetType.PRODUCT) {
      return this.ordersRepository.hasDeliveredProductOrder(userId, orderId, targetId);
    }
    return false;
  }

  /** Admin overview: orders per status, one query. */
  countByStatus(): Promise<{ status: OrderStatus; count: number }[]> {
    return this.ordersRepository.groupByStatus();
  }

  // --- Admin (specs/admin-module-spec2.md A5): read-only; status overrides,
  // cancel and refund are Open Item B6 ---

  async listForAdmin(params: {
    status?: OrderStatus;
    vendorId?: string;
    userId?: string;
    orderGroupId?: string;
    page: number;
    limit: number;
  }) {
    const { data, total } = await this.ordersRepository.findManyForAdmin(params);
    return { data, meta: pageMeta(total, params.page, params.limit) };
  }

  async getOrderForAdmin(orderId: string): Promise<AdminOrderDetail> {
    const order = await this.ordersRepository.findByIdForAdmin(orderId);
    if (!order) {
      throw orderNotFound();
    }
    return order;
  }
}
