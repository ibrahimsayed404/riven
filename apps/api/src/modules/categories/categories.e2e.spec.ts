import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('CategoriesModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    // Products reference categories; clear them first so the FK allows the wipe.
    await prisma.orderItem.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();

    const women = await prisma.category.create({ data: { name: 'Women', slug: 'e2e-women' } });
    await prisma.category.create({ data: { name: 'Men', slug: 'e2e-men' } });
    await prisma.category.create({
      data: { name: 'Dresses', slug: 'e2e-women-dresses', parentId: women.id },
    });
  });

  afterAll(async () => {
    await prisma.category.deleteMany();
    await app.close();
  });

  it('GET /categories returns the tree without auth, children nested under parents', async () => {
    const res = await request(app.getHttpServer()).get('/categories').expect(200);

    const slugs = res.body.map((n: { slug: string }) => n.slug);
    expect(slugs).toEqual(['e2e-men', 'e2e-women']);

    const women = res.body.find((n: { slug: string }) => n.slug === 'e2e-women');
    expect(women.children).toEqual([
      expect.objectContaining({ name: 'Dresses', slug: 'e2e-women-dresses', children: [] }),
    ]);
    expect(women).not.toHaveProperty('parentId');
  });
});
