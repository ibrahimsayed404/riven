import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { BarcodeStatus, Prisma, Role, VendorType } from '@prisma/client';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BarcodesService } from './barcodes.service';

// riven-barcode-inventory-plan B1 on real PostgreSQL: uniqueness, immutability,
// resolution outcomes and the vendor / admin permission split.
describe('Barcode registry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let barcodes: BarcodesService;
  const tokens = { admin: '', vendorA: '', vendorB: '', shopper: '' };
  let adminId: string;
  let vendorAOwner: string;
  let vendorA: string;
  let vendorB: string;
  let variantA1: string;
  let variantA2: string;
  let variantB1: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.PROCESS_ROLE = 'api';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    barcodes = app.get(BarcodesService);
    await wipe();

    const jwt = app.get(JwtService);
    const user = async (email: string, role: Role) => prisma.user.create({ data: { email, passwordHash: 'x', name: 'X', role } });
    const admin = await user('bc-admin@example.com', Role.ADMIN);
    const ownerA = await user('bc-vendor-a@example.com', Role.VENDOR);
    const ownerB = await user('bc-vendor-b@example.com', Role.VENDOR);
    const shopper = await user('bc-shopper@example.com', Role.SHOPPER);
    adminId = admin.id;
    vendorAOwner = ownerA.id;
    tokens.admin = await jwt.signAsync({ sub: admin.id, role: Role.ADMIN });
    tokens.vendorA = await jwt.signAsync({ sub: ownerA.id, role: Role.VENDOR });
    tokens.vendorB = await jwt.signAsync({ sub: ownerB.id, role: Role.VENDOR });
    tokens.shopper = await jwt.signAsync({ sub: shopper.id, role: Role.SHOPPER });

    vendorA = (await prisma.vendor.create({ data: { ownerId: ownerA.id, name: 'BC A', verified: true, vendorType: VendorType.MARKETPLACE } })).id;
    vendorB = (await prisma.vendor.create({ data: { ownerId: ownerB.id, name: 'BC B', verified: true, vendorType: VendorType.MARKETPLACE } })).id;
    const category = await prisma.category.create({ data: { name: 'BC', slug: 'bc-category' } });
    const product = async (vendorId: string) =>
      prisma.product.create({ data: { vendorId, title: 'BC Tee', description: 'x', categoryId: category.id, basePrice: new Prisma.Decimal(100) } });
    const pA = await product(vendorA);
    const pB = await product(vendorB);
    variantA1 = (await prisma.productVariant.create({ data: { productId: pA.id, sku: 'BC-A1' } })).id;
    variantA2 = (await prisma.productVariant.create({ data: { productId: pA.id, sku: 'BC-A2' } })).id;
    variantB1 = (await prisma.productVariant.create({ data: { productId: pB.id, sku: 'BC-B1' } })).id;
  });

  afterAll(async () => {
    await wipe();
    await app?.close();
    delete process.env.PROCESS_ROLE;
  });

  async function wipe() {
    // barcodes / barcode_events refuse DELETE (append-only); TRUNCATE is the test reset.
    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.$executeRawUnsafe(`TRUNCATE "barcode_events", "barcodes"`);
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'BC-' } } });
    await prisma.product.deleteMany({ where: { title: 'BC Tee' } });
    await prisma.category.deleteMany({ where: { slug: 'bc-category' } });
    await prisma.vendor.deleteMany({ where: { name: { startsWith: 'BC ' } } });
    await prisma.adminAuditLog.deleteMany({ where: { actor: { email: { startsWith: 'bc-' } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'bc-' } } });
  }

  const propose = (token: string, body: Record<string, unknown>) => http().post('/vendors/me/barcodes').set('Authorization', `Bearer ${token}`).send(body);
  const asAdmin = (method: 'get' | 'post' | 'patch', path: string) => http()[method](path).set('Authorization', `Bearer ${tokens.admin}`);

  describe('vendor proposals', () => {
    it('a vendor proposes for its own variant → PENDING_APPROVAL, never active on its own', async () => {
      const res = await propose(tokens.vendorA, { variantId: variantA1, value: '0012345678905\r\n', packagingType: 'UNIT' }).expect(201);
      expect(res.body).toMatchObject({ value: '0012345678905', status: 'PENDING_APPROVAL', unitsPerPackage: 1 });
      expect((await barcodes.resolve('0012345678905', vendorA)).outcome).toBe('BARCODE_NOT_APPROVED');
    });

    it("403 VARIANT_NOT_OWNED for another vendor's variant; 400 for the RVN namespace and bad conversions", async () => {
      const r1 = await propose(tokens.vendorA, { variantId: variantB1, value: 'X1', packagingType: 'UNIT' }).expect(403);
      expect(r1.body.code).toBe('VARIANT_NOT_OWNED');
      expect((await propose(tokens.vendorA, { variantId: variantA1, value: 'rvn-001', packagingType: 'UNIT' }).expect(400)).body.code).toBe('BARCODE_RESERVED_NAMESPACE');
      expect((await propose(tokens.vendorA, { variantId: variantA1, value: 'P1', packagingType: 'PACK' }).expect(400)).body.code).toBe('BARCODE_INVALID_CONVERSION');
      expect((await propose(tokens.vendorA, { variantId: variantA1, value: 'U1', packagingType: 'UNIT', unitsPerPackage: 3 }).expect(400)).body.code).toBe('BARCODE_INVALID_CONVERSION');
    });

    it('the same value is fine for two vendors (edge 1), but twice for one vendor is 409 (edge 18) — even when racing', async () => {
      await propose(tokens.vendorB, { variantId: variantB1, value: '0012345678905', packagingType: 'UNIT' }).expect(201);
      const [a, b] = await Promise.all([
        propose(tokens.vendorA, { variantId: variantA2, value: 'RACE-1', packagingType: 'CASE', unitsPerPackage: 12 }),
        propose(tokens.vendorA, { variantId: variantA1, value: 'RACE-1', packagingType: 'UNIT' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a.body.code, b.body.code]).toContain('BARCODE_ALREADY_REGISTERED');
    });

    it('a vendor lists only its own vendor barcodes and can withdraw its pending proposal; a withdrawn value can be proposed again', async () => {
      const created = await propose(tokens.vendorA, { variantId: variantA1, value: 'WD-1', packagingType: 'UNIT' }).expect(201);
      const listB = await http().get('/vendors/me/barcodes').set('Authorization', `Bearer ${tokens.vendorB}`).expect(200);
      expect(listB.body.data.map((b: { value: string }) => b.value)).not.toContain('WD-1');
      await http().delete(`/vendors/me/barcodes/${created.body.id}`).set('Authorization', `Bearer ${tokens.vendorB}`).expect(404);
      const withdrawn = await http().delete(`/vendors/me/barcodes/${created.body.id}`).set('Authorization', `Bearer ${tokens.vendorA}`).expect(200);
      expect(withdrawn.body.status).toBe('REJECTED');
      await propose(tokens.vendorA, { variantId: variantA1, value: 'WD-1', packagingType: 'UNIT' }).expect(201);
    });
  });

  describe('admin decisions and history', () => {
    it('approve → ACTIVE (audited); a repeat approve is a no-op; the barcode then resolves', async () => {
      const pending = await propose(tokens.vendorA, { variantId: variantA2, value: 'CASE-12', packagingType: 'CASE', unitsPerPackage: 12 }).expect(201);
      await asAdmin('post', `/admin/barcodes/${pending.body.id}/approve`).expect(200);
      const auditsBefore = await prisma.adminAuditLog.count({ where: { targetId: pending.body.id } });
      await asAdmin('post', `/admin/barcodes/${pending.body.id}/approve`).expect(200);
      expect(await prisma.adminAuditLog.count({ where: { targetId: pending.body.id } })).toBe(auditsBefore);

      const r = await barcodes.resolve('CASE-12', vendorA);
      expect(r).toMatchObject({ outcome: 'RESOLVED', barcode: { packagingType: 'CASE', unitsPerPackage: 12 }, variant: { id: variantA2 } });
    });

    it('reject needs a reason; deactivate / activate are guarded and audited; history is complete and ordered', async () => {
      const p = await propose(tokens.vendorA, { variantId: variantA1, value: 'REJ-1', packagingType: 'UNIT' }).expect(201);
      await asAdmin('post', `/admin/barcodes/${p.body.id}/reject`).send({}).expect(400);
      await asAdmin('post', `/admin/barcodes/${p.body.id}/reject`).send({ reason: 'label unreadable' }).expect(200);
      expect((await asAdmin('post', `/admin/barcodes/${p.body.id}/approve`).expect(409)).body.code).toBe('BARCODE_STATE_CONFLICT');

      const a = await propose(tokens.vendorA, { variantId: variantA1, value: 'LIFE-1', packagingType: 'UNIT' }).expect(201);
      await asAdmin('post', `/admin/barcodes/${a.body.id}/approve`).expect(200);
      await asAdmin('post', `/admin/barcodes/${a.body.id}/deactivate`).send({ reason: 'label replaced' }).expect(200);
      expect((await barcodes.resolve('LIFE-1', vendorA)).outcome).toBe('BARCODE_INACTIVE');
      await asAdmin('post', `/admin/barcodes/${a.body.id}/activate`).send({ reason: 'back in use' }).expect(200);

      const detail = await asAdmin('get', `/admin/barcodes/${a.body.id}`).expect(200);
      expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual(['PROPOSED', 'APPROVED', 'DEACTIVATED', 'ACTIVATED']);
      expect(await prisma.adminAuditLog.count({ where: { targetId: a.body.id } })).toBe(3);
    });

    it('conversion change bumps configVersion and records before / after; UNIT conversions are fixed (edge 20)', async () => {
      const p = await propose(tokens.vendorA, { variantId: variantA1, value: 'PACK-3', packagingType: 'PACK', unitsPerPackage: 3 }).expect(201);
      await asAdmin('post', `/admin/barcodes/${p.body.id}/approve`).expect(200);
      const changed = await asAdmin('patch', `/admin/barcodes/${p.body.id}`).send({ unitsPerPackage: 4, reason: 'supplier repacked' }).expect(200);
      expect(changed.body).toMatchObject({ unitsPerPackage: 4, configVersion: 2 });
      const event = await prisma.barcodeEvent.findFirstOrThrow({ where: { barcodeId: p.body.id, type: 'CONVERSION_CHANGED' } });
      expect(event.before).toMatchObject({ unitsPerPackage: 3, configVersion: 1 });
      expect(event.after).toMatchObject({ unitsPerPackage: 4, configVersion: 2 });

      const unit = await propose(tokens.vendorA, { variantId: variantA1, value: 'UNIT-FIX', packagingType: 'UNIT' }).expect(201);
      expect((await asAdmin('patch', `/admin/barcodes/${unit.body.id}`).send({ unitsPerPackage: 2, reason: 'x' }).expect(400)).body.code).toBe('BARCODE_UNIT_CONVERSION_FIXED');
    });

    it('admin creates an internal RVN barcode (globally unique) and registers a vendor barcode (active at once)', async () => {
      const internal = await asAdmin('post', '/admin/barcodes/internal').send({ variantId: variantB1, packagingType: 'UNIT' }).expect(201);
      expect(internal.body).toMatchObject({ scope: 'INTERNAL', status: 'ACTIVE', vendorId: vendorB });
      expect(internal.body.value).toMatch(/^RVN[0-9A-HJKMNP-TV-Z]{10}$/);

      const registered = await asAdmin('post', '/admin/barcodes/vendor')
        .send({ vendorId: vendorA, variantId: variantA1, value: 'UNKNOWN-SCAN-1', packagingType: 'UNIT', reason: 'registered after unknown scan' })
        .expect(201);
      expect(registered.body).toMatchObject({ status: 'ACTIVE', source: 'ADMIN_REGISTERED' });
      expect((await asAdmin('post', '/admin/barcodes/vendor').send({ vendorId: vendorA, variantId: variantB1, value: 'X2', packagingType: 'UNIT', reason: 'r' }).expect(403)).body.code).toBe('VARIANT_NOT_OWNED');
    });
  });

  describe('resolution (plan §F.2) and integrity', () => {
    it('vendor scope: a value of another vendor → VENDOR_MISMATCH (edge 3); an unregistered value → BARCODE_UNKNOWN (edge 5)', async () => {
      await asAdmin('post', '/admin/barcodes/vendor').send({ vendorId: vendorB, variantId: variantB1, value: 'ONLY-B', packagingType: 'UNIT', reason: 'r' }).expect(201);
      expect((await barcodes.resolve('ONLY-B', vendorA)).outcome).toBe('VENDOR_MISMATCH');
      expect((await barcodes.resolve('NEVER-SEEN', vendorA)).outcome).toBe('BARCODE_UNKNOWN');
      expect((await barcodes.resolve('\u0007', vendorA)).outcome).toBe('BARCODE_INVALID_FORMAT');
    });

    it("an internal barcode resolves only for its own vendor's session (internal → mismatch elsewhere)", async () => {
      const internal = await asAdmin('post', '/admin/barcodes/internal').send({ variantId: variantA1, packagingType: 'CASE', unitsPerPackage: 6 }).expect(201);
      expect((await barcodes.resolve(internal.body.value, vendorA)).outcome).toBe('RESOLVED');
      expect((await barcodes.resolve(internal.body.value, vendorB)).outcome).toBe('VENDOR_MISMATCH');
    });

    it('a deleted variant → VARIANT_UNAVAILABLE (edge 6)', async () => {
      const v = await prisma.productVariant.create({ data: { productId: (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantA1 } })).productId, sku: 'BC-DEL' } });
      await asAdmin('post', '/admin/barcodes/vendor').send({ vendorId: vendorA, variantId: v.id, value: 'DEL-1', packagingType: 'UNIT', reason: 'r' }).expect(201);
      await prisma.productVariant.update({ where: { id: v.id }, data: { deletedAt: new Date() } });
      expect((await barcodes.resolve('DEL-1', vendorA)).outcome).toBe('VARIANT_UNAVAILABLE');
    });

    it('lookup endpoint: admin only, same resolver', async () => {
      await http().post('/admin/barcodes/lookup').set('Authorization', `Bearer ${tokens.vendorA}`).send({ value: 'x', vendorId: vendorA }).expect(403);
      const res = await asAdmin('post', '/admin/barcodes/lookup').send({ value: 'NEVER-SEEN', vendorId: vendorA }).expect(200);
      expect(res.body.outcome).toBe('BARCODE_UNKNOWN');
    });

    it('database rules: the mapping is frozen once decided; history and barcodes cannot be deleted; namespace CHECK', async () => {
      const b = await prisma.barcode.findFirstOrThrow({ where: { status: BarcodeStatus.ACTIVE, scope: 'VENDOR' } });
      const other = b.variantId === variantA2 ? variantA1 : variantA2;
      await expect(prisma.barcode.update({ where: { id: b.id }, data: { variantId: other } })).rejects.toThrow(/immutable/);
      await expect(prisma.$executeRaw`DELETE FROM "barcode_events"`).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`DELETE FROM "barcodes"`).rejects.toThrow(/append-only|foreign key/);
      await expect(
        prisma.barcode.create({ data: { value: 'RVN-VENDOR', scope: 'VENDOR', vendorId: vendorA, variantId: variantA1, packagingType: 'UNIT', unitsPerPackage: 1, status: 'ACTIVE', source: 'X' } }),
      ).rejects.toThrow(/barcodes_namespace_check/);
    });

    it('permissions: shopper and vendor tokens get 403 on admin routes; no token 401', async () => {
      await http().get('/admin/barcodes').expect(401);
      await http().get('/admin/barcodes').set('Authorization', `Bearer ${tokens.shopper}`).expect(403);
      await http().get('/admin/barcodes').set('Authorization', `Bearer ${tokens.vendorA}`).expect(403);
      await http().get('/vendors/me/barcodes').set('Authorization', `Bearer ${tokens.admin}`).expect(403);
      void adminId;
      void vendorAOwner;
    });
  });
});
