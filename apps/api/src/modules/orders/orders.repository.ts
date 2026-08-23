import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

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
      },
    });
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<Order> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
  }
}
