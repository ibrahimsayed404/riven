import { PaymentExceptionStatus } from '@prisma/client';

import { CheckoutRepository } from './checkout.repository';
import { PaymentExceptionsService } from './payment-exceptions.service';

const exception = (status: PaymentExceptionStatus) => ({ id: 'pe-1', status }) as any;

describe('PaymentExceptionsService (commerce/25 S1)', () => {
  let repo: jest.Mocked<CheckoutRepository>;
  let service: PaymentExceptionsService;

  beforeEach(() => {
    repo = {
      findPaymentExceptionsForAdmin: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      findPaymentExceptionByIdForAdmin: jest.fn(),
      resolvePaymentException: jest.fn().mockResolvedValue(1),
      countOpenPaymentExceptions: jest.fn().mockResolvedValue(2),
    } as unknown as jest.Mocked<CheckoutRepository>;
    service = new PaymentExceptionsService(repo);
  });

  it('lists with page meta', async () => {
    await expect(service.listForAdmin({ page: 1, limit: 20 })).resolves.toEqual({ data: [], meta: expect.objectContaining({ total: 0, page: 1, limit: 20 }) });
  });

  it('404 PAYMENT_EXCEPTION_NOT_FOUND for an unknown id', async () => {
    repo.findPaymentExceptionByIdForAdmin.mockResolvedValue(null);
    await expect(service.getForAdmin('x')).rejects.toMatchObject({ status: 404, response: { code: 'PAYMENT_EXCEPTION_NOT_FOUND' } });
  });

  it('resolve: OPEN → RESOLVED with the note and the actor (the repository audits in the same transaction, TD-03)', async () => {
    repo.findPaymentExceptionByIdForAdmin.mockResolvedValueOnce(exception('OPEN')).mockResolvedValueOnce(exception('RESOLVED'));
    await expect(service.resolveForAdmin('admin-1', 'pe-1', 'Refunded manually, Paymob ref 77')).resolves.toMatchObject({ status: 'RESOLVED' });
    expect(repo.resolvePaymentException).toHaveBeenCalledWith('pe-1', 'admin-1', 'Refunded manually, Paymob ref 77');
  });

  it('resolve an already RESOLVED one → 409, nothing written', async () => {
    repo.findPaymentExceptionByIdForAdmin.mockResolvedValue(exception('RESOLVED'));
    await expect(service.resolveForAdmin('admin-1', 'pe-1', 'again, ten chars')).rejects.toMatchObject({ status: 409, response: { code: 'PAYMENT_EXCEPTION_ALREADY_RESOLVED' } });
    expect(repo.resolvePaymentException).not.toHaveBeenCalled();
  });

  it('two admins resolving at once: the guarded write moves 0 rows for the loser → 409', async () => {
    repo.findPaymentExceptionByIdForAdmin.mockResolvedValue(exception('OPEN'));
    repo.resolvePaymentException.mockResolvedValue(0);
    await expect(service.resolveForAdmin('admin-2', 'pe-1', 'second admin note')).rejects.toMatchObject({ status: 409 });
  });

  it('countOpen feeds the health monitor', async () => {
    await expect(service.countOpen()).resolves.toBe(2);
  });
});
