import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentExceptionStatus, PaymentExceptionType } from '@prisma/client';

import { pageMeta } from '../../common/dto/pagination-query.dto';
import { AdminPaymentException, CheckoutRepository } from './checkout.repository';

const notFound = () => new NotFoundException({ code: 'PAYMENT_EXCEPTION_NOT_FOUND', message: 'Payment exception not found.' });

/**
 * Charges that were recorded but not applied normally (specs/commerce/25 S1):
 * double, late, wrong-amount and wrong-currency payments. Admins see them and
 * close each one with a note saying what was done (e.g. a manual refund).
 * Resolving changes no money and no order — there is no refund automation
 * until a refund process exists (FD-12, payments spec).
 */
@Injectable()
export class PaymentExceptionsService {
  constructor(private readonly checkoutRepository: CheckoutRepository) {}

  async listForAdmin(params: {
    status?: PaymentExceptionStatus;
    type?: PaymentExceptionType;
    orderGroupId?: string;
    page: number;
    limit: number;
  }) {
    const { data, total } = await this.checkoutRepository.findPaymentExceptionsForAdmin(params);
    return { data, meta: pageMeta(total, params.page, params.limit) };
  }

  async getForAdmin(id: string): Promise<AdminPaymentException> {
    const exception = await this.checkoutRepository.findPaymentExceptionByIdForAdmin(id);
    if (!exception) throw notFound();
    return exception;
  }

  /** OPEN → RESOLVED with a note; a repeat on a resolved one is a 409 (the first note stands). Audited in the same transaction (TD-03). */
  async resolveForAdmin(adminId: string, id: string, note: string): Promise<AdminPaymentException> {
    const exception = await this.getForAdmin(id);
    if (exception.status === PaymentExceptionStatus.RESOLVED) {
      throw new ConflictException({ code: 'PAYMENT_EXCEPTION_ALREADY_RESOLVED', message: 'This payment exception is already resolved.' });
    }
    if ((await this.checkoutRepository.resolvePaymentException(id, adminId, note)) === 0) {
      // Another admin resolved it between our read and the write.
      throw new ConflictException({ code: 'PAYMENT_EXCEPTION_ALREADY_RESOLVED', message: 'This payment exception is already resolved.' });
    }
    return this.getForAdmin(id);
  }

  /** For monitoring (GET /health/maintenance). */
  countOpen(): Promise<number> {
    return this.checkoutRepository.countOpenPaymentExceptions();
  }
}
