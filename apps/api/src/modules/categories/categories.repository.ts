import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }
}
