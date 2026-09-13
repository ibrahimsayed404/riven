import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, RatingTargetType } from '@prisma/client';
import { OrdersRepository } from './orders.repository';

// Valid forward transitions
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

@Injectable()
export class OrdersService {
  constructor(private readonly ordersRepository: OrdersRepository) {}

  validateTransition(currentStatus: OrderStatus, newStatus: OrderStatus) {
    const allowed = ORDER_STATUS_TRANSITIONS[currentStatus];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Cannot transition order from ${currentStatus} to ${newStatus}. Allowed next states: ${allowed.join(', ') || 'none'}`
      );
    }
  }

  async getShopperOrders(userId: string, page: number, limit: number, status?: OrderStatus) {
    return this.ordersRepository.findShopperOrders(userId, page, limit, status);
  }

  async getShopperOrder(userId: string, orderId: string) {
    const order = await this.ordersRepository.getShopperOrder(userId, orderId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  async cancelOrder(userId: string, orderId: string) {
    const order = await this.getShopperOrder(userId, orderId);
    
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Orders can only be cancelled before payment; contact support for a paid order');
    }

    this.validateTransition(order.status, 'CANCELLED');

    return this.ordersRepository.updateOrderStatus(orderId, 'CANCELLED');
  }

  async confirmDelivery(userId: string, orderId: string) {
    const order = await this.getShopperOrder(userId, orderId);
    
    if (order.status !== 'SHIPPED') {
      throw new BadRequestException(`Delivery can only be confirmed for SHIPPED orders. Current status is ${order.status}`);
    }

    this.validateTransition(order.status, 'DELIVERED');

    return this.ordersRepository.updateOrderStatus(orderId, 'DELIVERED');
  }

  async getVendorOrders(vendorId: string, page: number, limit: number, status?: OrderStatus) {
    return this.ordersRepository.findVendorOrders(vendorId, page, limit, status);
  }

  async getVendorOrder(vendorId: string, orderId: string) {
    const order = await this.ordersRepository.getVendorOrder(vendorId, orderId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  async updateVendorOrderStatus(vendorId: string, orderId: string, newStatus: OrderStatus) {
    const order = await this.getVendorOrder(vendorId, orderId);
    
    // Vendor is only allowed to transition PAID->FULFILLED, FULFILLED->SHIPPED
    if (newStatus !== 'FULFILLED' && newStatus !== 'SHIPPED') {
      throw new BadRequestException(`Vendors can only update status to FULFILLED or SHIPPED`);
    }

    this.validateTransition(order.status, newStatus);

    return this.ordersRepository.updateOrderStatus(orderId, newStatus);
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
}
