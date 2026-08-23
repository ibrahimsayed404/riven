import { Injectable } from '@nestjs/common';
import { Prisma, Product, ProductVariant } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get visibilityFilter(): Prisma.ProductWhereInput {
    return {
      isActive: true,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      vendor: {
        verified: true,
      },
    };
  }

  async findManyPaginated(params: {
    categoryId?: string;
    vendorId?: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{ data: Product[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...this.visibilityFilter,
    };

    if (params.categoryId) {
      where.categoryId = params.categoryId;
    }

    if (params.vendorId) {
      where.vendorId = params.vendorId;
    }

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.product.count({ where });
      const data = await tx.product.findMany({
        where,
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        orderBy: { createdAt: 'desc' },
      });
      return { data, total };
    });
  }

  findById(id: string): Promise<(Product & { variants: ProductVariant[] }) | null> {
    return this.prisma.product.findFirst({
      where: {
        id,
        ...this.visibilityFilter,
      },
      include: {
        variants: true,
      },
    });
  }

  updateAdminStatus(id: string, data: { approvalStatus: Prisma.ProductUpdateInput['approvalStatus'], rejectionReason: string | null }): Promise<Product> {
    return this.prisma.product.update({
      where: { id },
      data,
    });
  }
}
