import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('MediaModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let vendorToken: string;
  let organizerToken: string;
  let shopperToken: string;
  let vendorUserId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) =>
          new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: errors.flatMap((error) => Object.values(error.constraints ?? {})),
          }),
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    const jwtService = app.get(JwtService);

    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany({ where: { email: { startsWith: 'media-' } } });

    const vendor = await prisma.user.create({
      data: { email: 'media-vendor@example.com', passwordHash: 'hash', name: 'V', role: Role.VENDOR },
    });
    const organizer = await prisma.user.create({
      data: { email: 'media-org@example.com', passwordHash: 'hash', name: 'O', role: Role.ORGANIZER },
    });
    const shopper = await prisma.user.create({
      data: { email: 'media-shopper@example.com', passwordHash: 'hash', name: 'S', role: Role.SHOPPER },
    });
    vendorUserId = vendor.id;
    vendorToken = await jwtService.signAsync({ sub: vendor.id, role: Role.VENDOR });
    organizerToken = await jwtService.signAsync({ sub: organizer.id, role: Role.ORGANIZER });
    shopperToken = await jwtService.signAsync({ sub: shopper.id, role: Role.SHOPPER });
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany({ where: { email: { startsWith: 'media-' } } });
    await app.close();
  });

  it('vendor gets a presigned PUT namespaced under their own id', async () => {
    const res = await request(app.getHttpServer())
      .post('/media/upload-url')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'image/png' })
      .expect(200);

    expect(res.body.key).toMatch(new RegExp(`^product-image/${vendorUserId}/[0-9a-f-]{36}\\.png$`));
    expect(res.body.publicUrl).toBe(`http://localhost:9000/riven-media/${res.body.key}`);
    expect(res.body.uploadUrl).toContain(`/riven-media/${res.body.key}?`);
    expect(res.body.uploadUrl).toContain('X-Amz-Signature=');
    expect(res.body.expiresInSeconds).toBe(300);
  });

  it('organizer can request a bazaar cover', async () => {
    const res = await request(app.getHttpServer())
      .post('/media/upload-url')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ purpose: 'BAZAAR_COVER', contentType: 'image/jpeg' })
      .expect(200);
    expect(res.body.key).toMatch(/^bazaar-cover\/.+\.jpg$/);
  });

  it('rejects a content type outside the image allowlist', async () => {
    const res = await request(app.getHttpServer())
      .post('/media/upload-url')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'application/pdf' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown purpose', async () => {
    await request(app.getHttpServer())
      .post('/media/upload-url')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ purpose: 'AVATAR', contentType: 'image/png' })
      .expect(400);
  });

  it('shoppers and anonymous callers are refused', async () => {
    await request(app.getHttpServer())
      .post('/media/upload-url')
      .set('Authorization', `Bearer ${shopperToken}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'image/png' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/media/upload-url')
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'image/png' })
      .expect(401);
  });
});
