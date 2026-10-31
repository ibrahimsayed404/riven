import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderStatus, Prisma, Role, VendorType } from '@prisma/client';
import { createHmac } from 'crypto';

import { PaymobModule } from '../../infra/paymob/paymob.module';
import { PaymobWebhookDispatcher } from '../../infra/paymob/paymob-webhook.dispatcher';
import { PAYMOB_HMAC_KEYS } from '../../infra/paymob/paymob.service';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CheckoutRepository } from './checkout.repository';
import { OrderPaymentHandler } from './order-payment.handler';

/**
 * specs/commerce/25 slice S1 on real PostgreSQL, through the real dispatcher,
 * handler and repositories with genuinely HMAC-signed callbacks (the brief's
 * acceptance tests 8 – 13 and 17). Refuses to run unless DATABASE_URL is a
 * *_test database: it truncates the payment evidence tables.
 */
const SECRET = 'test-hmac-secret-for-e2e';
const PREFIX = 'pw-';

function sign(obj: Record<string, unknown>): string {
  let concatenated = '';
  for (const key of PAYMOB_HMAC_KEYS) {
    let value: unknown = obj;
    for (const part of key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    if (typeof value === 'boolean') concatenated += value ? 'true' : 'false';
    else if (value !== undefined && value !== null) concatenated += String(value);
  }
  return createHmac('sha512', SECRET).update(concatenated).digest('hex');
}

describe('Paymob webhook hardening S1 (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let dispatcher: PaymobWebhookDispatcher;
  let repo: CheckoutRepository;

  let shopperId: string;
  let adminId: string;
  let vendorId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!/\/[^/?]+_test(\?|$)/.test(url)) {
      throw new Error('payment-webhook e2e must run against a *_test database (it truncates payment evidence).');
    }
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ PAYMOB_HMAC_SECRET: SECRET, PAYMOB_INTEGRATION_ID: '4242', PAYMOB_MERCHANT_ID: '7777' })] }),
        PrismaModule,
        PaymobModule,
      ],
      providers: [CheckoutRepository, OrderPaymentHandler],
    }).compile();
    await moduleRef.init(); // OrderPaymentHandler registers itself with the dispatcher
    prisma = moduleRef.get(PrismaService);
    dispatcher = moduleRef.get(PaymobWebhookDispatcher);
    repo = moduleRef.get(CheckoutRepository);
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);

    await wipe();
    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'PW-' } } });
    await prisma.product.deleteMany({ where: { title: { startsWith: 'PW ' } } });
    await prisma.vendor.deleteMany({ where: { owner: { email: { startsWith: PREFIX } } } });
    await prisma.category.deleteMany({ where: { slug: 'pw-category' } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    shopperId = (await prisma.user.create({ data: { email: `${PREFIX}shopper@example.com`, passwordHash: 'x', name: 'S', role: Role.SHOPPER } })).id;
    adminId = (await prisma.user.create({ data: { email: `${PREFIX}admin@example.com`, passwordHash: 'x', name: 'A', role: Role.ADMIN } })).id;
    const vendorUser = await prisma.user.create({ data: { email: `${PREFIX}vendor@example.com`, passwordHash: 'x', name: 'V', role: Role.VENDOR } });
    vendorId = (await prisma.vendor.create({ data: { ownerId: vendorUser.id, name: 'PW Shop', verified: true, vendorType: VendorType.MARKETPLACE } })).id;
    const category = await prisma.category.create({ data: { name: 'PW', slug: 'pw-category' } });
    productId = (await prisma.product.create({ data: { vendorId, title: 'PW Tee', description: 'x', categoryId: category.id, basePrice: new Prisma.Decimal(30.4) } })).id;
    variantId = (await prisma.productVariant.create({ data: { productId, sku: 'PW-1', stockQuantity: 100 } })).id;
  });

  afterAll(async () => {
    await wipe();
    await moduleRef?.close();
  });

  async function wipe() {
    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions", "payment_provider_events"');
    await prisma.adminAuditLog.deleteMany({ where: { actor: { email: { startsWith: PREFIX } } } });
    await prisma.orderItem.deleteMany({ where: { order: { user: { email: { startsWith: PREFIX } } } } });
    await prisma.order.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
    await prisma.orderGroup.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  }

  /** A checkout waiting for payment: one PENDING order of 30.40 EGP (3040 piastres), Paymob order id set. */
  let nextPaymobOrderId = Date.now() % 1_000_000_000;
  async function pendingGroup(status: OrderStatus = OrderStatus.PENDING) {
    // Paymob order ids are positive integers (signed field; strict format, commerce/25 §10).
    const paymobOrderId = String(++nextPaymobOrderId);
    const group = await prisma.orderGroup.create({ data: { userId: shopperId, paymobOrderId } });
    await prisma.order.create({
      data: {
        orderGroupId: group.id,
        vendorId,
        userId: shopperId,
        status,
        subtotal: new Prisma.Decimal('30.40'),
        items: { create: [{ productId, variantId, titleSnapshot: 'PW Tee', priceSnapshot: new Prisma.Decimal('30.40'), quantity: 1 }] },
      },
    });
    return { groupId: group.id, paymobOrderId };
  }

  /** A signed Paymob transaction callback (classic `{ type, obj }` body) + its HMAC. */
  function callback(paymobOrderId: string, over: Record<string, unknown> = {}) {
    const obj: Record<string, unknown> = {
      id: Math.floor(Math.random() * 1e12),
      success: true,
      pending: false,
      error_occured: false,
      is_refunded: false,
      is_voided: false,
      is_auth: false,
      is_capture: false,
      is_3d_secure: true,
      is_standalone_payment: true,
      has_parent_transaction: false,
      amount_cents: 3040,
      created_at: '2026-10-31T10:00:00.123456',
      currency: 'EGP',
      integration_id: 4242,
      owner: 7777,
      order: { id: Number(paymobOrderId) },
      ...over,
    };
    return { body: { type: 'TRANSACTION', obj }, hmac: sign(obj), txId: String(obj.id) };
  }

  const ordersOf = async (groupId: string) => (await prisma.order.findMany({ where: { orderGroupId: groupId } })).map((o) => o.status);
  const exceptionsOf = (groupId: string) => prisma.paymentException.findMany({ where: { orderGroupId: groupId }, orderBy: { createdAt: 'asc' } });
  const eventsFor = (txId: string) => prisma.paymentProviderEvent.findMany({ where: { providerTransactionId: txId } });

  it('#12 an invalid signature is rejected and nothing is stored', async () => {
    const { paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId);
    await expect(dispatcher.dispatch(cb.body, 'f'.repeat(128))).rejects.toMatchObject({ response: { code: 'WEBHOOK_SIGNATURE_INVALID' } });
    const tampered = { ...cb.body, obj: { ...cb.body.obj, amount_cents: 1 } };
    await expect(dispatcher.dispatch(tampered, cb.hmac)).rejects.toMatchObject({ status: 401 });
    expect(await eventsFor(cb.txId)).toHaveLength(0);
  });

  it('#8 the same webhook delivered 10 times: one stored event, one PAID transition, no exception', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId);
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) outcomes.push((await dispatcher.dispatch(cb.body, cb.hmac)).outcome);

    expect(outcomes[0]).toBe('paid');
    expect(outcomes.slice(1).every((o) => o === 'duplicate')).toBe(true);
    expect(await eventsFor(cb.txId)).toHaveLength(1);
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
    expect(await exceptionsOf(groupId)).toHaveLength(0);
    const group = await prisma.orderGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(group.paymobTransactionId).toBe(cb.txId);
    expect(group.paidAmountCents).toBe(3040);
    expect(group.paidAt).not.toBeNull();
  });

  it('#9 10 identical webhooks at the same moment: exactly one transition is applied (×5)', async () => {
    for (let round = 0; round < 5; round++) {
      const { groupId, paymobOrderId } = await pendingGroup();
      const cb = callback(paymobOrderId);
      const results = await Promise.all(Array.from({ length: 10 }, () => dispatcher.dispatch(cb.body, cb.hmac)));

      expect(results.filter((r) => r.outcome === 'paid')).toHaveLength(1);
      expect(results.every((r) => r.outcome === 'paid' || r.outcome === 'duplicate')).toBe(true);
      expect(await eventsFor(cb.txId)).toHaveLength(1);
      expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
      expect(await exceptionsOf(groupId)).toHaveLength(0);
    }
  });

  it('#10 a second, different successful charge: DOUBLE_PAYMENT recorded with its own transaction, first payment kept, idempotent', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const first = callback(paymobOrderId);
    const second = callback(paymobOrderId);
    expect((await dispatcher.dispatch(first.body, first.hmac)).outcome).toBe('paid');
    expect((await dispatcher.dispatch(second.body, second.hmac)).outcome).toBe('double_payment');
    expect((await dispatcher.dispatch(second.body, second.hmac)).outcome).toBe('duplicate'); // re-delivery

    const exceptions = await exceptionsOf(groupId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ type: 'DOUBLE_PAYMENT', status: 'OPEN', providerTransactionId: second.txId, amountCents: 3040, currency: 'EGP' });
    expect((await prisma.orderGroup.findUniqueOrThrow({ where: { id: groupId } })).paymobTransactionId).toBe(first.txId);
    expect(await eventsFor(first.txId)).toHaveLength(1);
    expect(await eventsFor(second.txId)).toHaveLength(1); // both provider transactions are stored
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]); // paid once, fulfilled once
  });

  it('#10 two different charges arriving at the same moment: one paid, one DOUBLE_PAYMENT, never both applied (×5)', async () => {
    for (let round = 0; round < 5; round++) {
      const { groupId, paymobOrderId } = await pendingGroup();
      const a = callback(paymobOrderId);
      const b = callback(paymobOrderId);
      const outcomes = (await Promise.all([dispatcher.dispatch(a.body, a.hmac), dispatcher.dispatch(b.body, b.hmac)])).map((r) => r.outcome).sort();
      expect(outcomes).toEqual(['double_payment', 'paid']);
      expect((await exceptionsOf(groupId)).map((e) => e.type)).toEqual(['DOUBLE_PAYMENT']);
      expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
    }
  });

  it('#11 a payment after the order was cancelled/expired: LATE_PAYMENT exception carries the charge, orders stay cancelled', async () => {
    const { groupId, paymobOrderId } = await pendingGroup(OrderStatus.CANCELLED);
    const cb = callback(paymobOrderId);
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('orphan');

    expect(await ordersOf(groupId)).toEqual([OrderStatus.CANCELLED]);
    const [exception] = await exceptionsOf(groupId);
    expect(exception).toMatchObject({ type: 'LATE_PAYMENT', providerTransactionId: cb.txId, amountCents: 3040 }); // the money is recorded
    const group = await prisma.orderGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(group.paymobTransactionId).toBeNull(); // only an applied payment claims the group
    expect(group.paidAt).toBeNull();
  });

  it('a wrong amount does not block the order: the group stays PENDING and unclaimed, and a later correct payment is applied', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const wrong = callback(paymobOrderId, { amount_cents: 100 });
    expect((await dispatcher.dispatch(wrong.body, wrong.hmac)).outcome).toBe('amount_mismatch');
    const after = await prisma.orderGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(after.paymobTransactionId).toBeNull(); // still expirable by the reservation job (its filter needs this null)
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PENDING]);

    const right = callback(paymobOrderId);
    expect((await dispatcher.dispatch(right.body, right.hmac)).outcome).toBe('paid');
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
    expect((await exceptionsOf(groupId)).map((e) => e.type)).toEqual(['AMOUNT_MISMATCH']); // the wrong charge stays on record for a refund
  });

  it('a signed charge that matches no order is recorded as an UNMATCHED_PAYMENT exception (and only once)', async () => {
    const cb = callback('987654321987');
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('unmatched');
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('duplicate');
    const rows = await prisma.paymentException.findMany({ where: { providerTransactionId: cb.txId } });
    expect(rows).toEqual([expect.objectContaining({ type: 'UNMATCHED_PAYMENT', orderGroupId: null, amountCents: 3040, status: 'OPEN' })]);
  });

  it('a malformed (but correctly signed) callback is refused and nothing is stored', async () => {
    const { paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId, { success: 'true' });
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('ignored');
    expect(await eventsFor(cb.txId)).toHaveLength(0);
  });

  it('#13 an amount mismatch is recorded as AMOUNT_MISMATCH and NOT applied', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId, { amount_cents: 3039 });
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('amount_mismatch');
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PENDING]);
    expect(await exceptionsOf(groupId)).toEqual([expect.objectContaining({ type: 'AMOUNT_MISMATCH', amountCents: 3039, expectedAmountCents: 3040 })]);
  });

  it('#13 a currency mismatch (USD) is recorded as CURRENCY_MISMATCH and NOT applied; a missing currency is refused outright', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId, { currency: 'USD' });
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('currency_mismatch');
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PENDING]);
    expect((await exceptionsOf(groupId)).map((e) => e.type)).toEqual(['CURRENCY_MISMATCH']);

    const missing = callback(paymobOrderId, { currency: undefined });
    expect((await dispatcher.dispatch(missing.body, missing.hmac)).outcome).toBe('ignored');
    expect(await eventsFor(missing.txId)).toHaveLength(0);
  });

  it('a correctly signed callback forged by shifting digits between signed fields is refused, and the genuine callback still pays (commerce/25 §11)', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const genuine = callback(paymobOrderId);
    const obj = genuine.body.obj as Record<string, unknown>;

    // id ‖ integration_id merged, integration_id dropped: same concatenated string, so the SAME valid HMAC
    const idShift: Record<string, unknown> = { ...obj, id: Number(`${obj.id}${obj.integration_id}`) };
    delete idShift.integration_id;
    expect(sign(idShift)).toBe(genuine.hmac);
    // created_at ‖ currency merged, currency nulled: the "drop the real payment" attack
    const currencyShift: Record<string, unknown> = { ...obj, created_at: `${obj.created_at}${obj.currency}`, currency: null };
    expect(sign(currencyShift)).toBe(genuine.hmac);
    // order.id ‖ owner merged, owner dropped
    const ownerShift: Record<string, unknown> = { ...obj, order: { id: Number(`${paymobOrderId}${obj.owner}`) } };
    delete ownerShift.owner;
    expect(sign(ownerShift)).toBe(genuine.hmac);

    for (const forged of [idShift, currencyShift, ownerShift]) {
      expect((await dispatcher.dispatch({ type: 'TRANSACTION', obj: forged }, genuine.hmac)).outcome).toBe('ignored');
    }
    expect(await prisma.paymentProviderEvent.count({ where: { providerTransactionId: { in: [genuine.txId, String(idShift.id)] } } })).toBe(0);
    expect(await prisma.paymentException.count({ where: { providerTransactionId: { in: [genuine.txId, String(idShift.id)] } } })).toBe(0);

    expect((await dispatcher.dispatch(genuine.body, genuine.hmac)).outcome).toBe('paid');
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
  });

  it('a refund or void callback (success: true, signed) is stored as evidence and never mistaken for a second charge', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const payment = callback(paymobOrderId);
    await dispatcher.dispatch(payment.body, payment.hmac);
    const refundChild = callback(paymobOrderId, { has_parent_transaction: true });
    const refundedParent = callback(paymobOrderId, { id: Number(payment.txId), is_refunded: true });

    expect((await dispatcher.dispatch(refundChild.body, refundChild.hmac)).outcome).toBe('ignored');
    expect((await dispatcher.dispatch(refundedParent.body, refundedParent.hmac)).outcome).toBe('ignored');

    expect(await exceptionsOf(groupId)).toHaveLength(0);
    expect((await eventsFor(refundChild.txId)).map((e) => e.kind)).toEqual(['REFUND']);
    expect((await eventsFor(payment.txId)).map((e) => e.kind).sort()).toEqual(['PAYMENT', 'REFUND']); // same id, two facts
  });

  it('#17 a crash INSIDE the payment transaction (after its writes, before commit) rolls everything back; the retry applies it once', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId);
    const original = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, options: any) =>
      original(async (tx: any) => {
        await fn(tx); // the claim, PENDING → PAID … all written
        throw new Error('process killed before COMMIT');
      }, options)) as any);

    await expect(dispatcher.dispatch(cb.body, cb.hmac)).rejects.toThrow('process killed before COMMIT');
    spy.mockRestore();
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PENDING]); // nothing survived the rollback
    expect((await prisma.orderGroup.findUniqueOrThrow({ where: { id: groupId } })).paymobTransactionId).toBeNull();
    expect((await eventsFor(cb.txId))[0].processedAt).toBeNull();

    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('paid');
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
  });

  it('#17 a crash while applying leaves the callback unprocessed; the provider retry applies it exactly once', async () => {
    const { groupId, paymobOrderId } = await pendingGroup();
    const cb = callback(paymobOrderId);
    const spy = jest.spyOn(repo, 'applyPayment').mockRejectedValueOnce(new Error('connection lost mid-transaction'));

    await expect(dispatcher.dispatch(cb.body, cb.hmac)).rejects.toThrow('connection lost');
    const [stored] = await eventsFor(cb.txId);
    expect(stored.processedAt).toBeNull();
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PENDING]);

    spy.mockRestore();
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('paid');
    expect((await dispatcher.dispatch(cb.body, cb.hmac)).outcome).toBe('duplicate');
    expect(await ordersOf(groupId)).toEqual([OrderStatus.PAID]);
    expect((await eventsFor(cb.txId))[0].processedAt).not.toBeNull();
  });

  describe('database guarantees (triggers and CHECKs)', () => {
    it('payment exceptions are never deleted and their facts never change; OPEN → RESOLVED once', async () => {
      const { groupId, paymobOrderId } = await pendingGroup(OrderStatus.CANCELLED);
      const cb = callback(paymobOrderId);
      await dispatcher.dispatch(cb.body, cb.hmac);
      const [exception] = await exceptionsOf(groupId);

      await expect(prisma.paymentException.delete({ where: { id: exception.id } })).rejects.toThrow(/never deleted/);
      await expect(prisma.paymentException.update({ where: { id: exception.id }, data: { amountCents: 1 } })).rejects.toThrow(/immutable/);
      // RESOLVED needs who, when and a note (CHECK)
      await expect(prisma.paymentException.update({ where: { id: exception.id }, data: { status: 'RESOLVED' } })).rejects.toThrow(/23514|check constraint/);

      expect(await repo.resolvePaymentException(exception.id, adminId, 'Refunded manually, ref 77')).toBe(1);
      // TD-03: the audit row was written in the same transaction as the resolution
      expect(await prisma.adminAuditLog.count({ where: { targetId: exception.id, action: 'PAYMENT_EXCEPTION_RESOLVED', actorId: adminId } })).toBe(1);
      expect(await repo.resolvePaymentException(exception.id, adminId, 'second try')).toBe(0); // guarded
      await expect(
        prisma.paymentException.update({ where: { id: exception.id }, data: { resolutionNote: 'rewritten history' } }),
      ).rejects.toThrow(/cannot change/);
    });

    it('TD-03: if the audit row cannot be written, the resolution rolls back with it (one transaction)', async () => {
      const { groupId, paymobOrderId } = await pendingGroup(OrderStatus.CANCELLED);
      const cb = callback(paymobOrderId);
      await dispatcher.dispatch(cb.body, cb.hmac);
      const [exception] = await exceptionsOf(groupId);

      const original = prisma.$transaction.bind(prisma);
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, options: any) =>
        original(
          (tx: any) =>
            fn(
              new Proxy(tx, {
                get: (target, prop) =>
                  prop === 'adminAuditLog'
                    ? { create: () => Promise.reject(new Error('audit insert failed')) }
                    : Reflect.get(target, prop),
              }),
            ),
          options,
        )) as any);
      try {
        await expect(repo.resolvePaymentException(exception.id, adminId, 'Refunded manually, ref 99')).rejects.toThrow('audit insert failed');
      } finally {
        spy.mockRestore();
      }
      // the status change was written first inside the transaction — and rolled back with the failed audit
      expect((await prisma.paymentException.findUniqueOrThrow({ where: { id: exception.id } })).status).toBe('OPEN');
      expect(await prisma.adminAuditLog.count({ where: { targetId: exception.id } })).toBe(0);
      expect(await repo.resolvePaymentException(exception.id, adminId, 'Refunded manually, ref 99')).toBe(1);
    });

    it('provider events are append-only: payload and amounts never change, rows never deleted', async () => {
      const { paymobOrderId } = await pendingGroup();
      const cb = callback(paymobOrderId);
      await dispatcher.dispatch(cb.body, cb.hmac);
      const [event] = await eventsFor(cb.txId);
      await expect(prisma.paymentProviderEvent.update({ where: { id: event.id }, data: { amountCents: 1 } })).rejects.toThrow(/only outcome/);
      await expect(prisma.paymentProviderEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
    });
  });
});
