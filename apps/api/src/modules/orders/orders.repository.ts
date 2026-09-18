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

    const total = await this.prisma.order.count({ where });
    const data = await this.prisma.order.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

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

    const total = await this.prisma.order.count({ where });
    const data = await this.prisma.order.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: SHOPPER_CONTACT_SELECT } },
    });

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

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<Order> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
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
