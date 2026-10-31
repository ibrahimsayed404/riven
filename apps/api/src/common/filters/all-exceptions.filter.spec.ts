import { ArgumentsHost, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWith(request: Record<string, unknown> = {}) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'GET', url: '/x', ...request }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('emits the flat { code, message } body with no envelope (API-01)', () => {
    const { host, status, json } = hostWith();
    filter.catch(new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found.' }), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found.' });
  });

  it('passes `details` through untouched (LOGIC-01)', () => {
    const { host, json } = hostWith();
    const details = { items: [{ cartItemId: 'ci-1', reason: 'OUT_OF_STOCK' }] };
    filter.catch(new BadRequestException({ code: 'CHECKOUT_ITEM_UNAVAILABLE', message: 'x', details }), host);
    expect(json).toHaveBeenCalledWith({ code: 'CHECKOUT_ITEM_UNAVAILABLE', message: 'x', details });
  });

  it('falls back to HTTP_ERROR for bare-string exceptions (ERR-01 remains visible)', () => {
    const { host, json } = hostWith();
    filter.catch(new NotFoundException('Bazaar not found.'), host);
    expect(json).toHaveBeenCalledWith({ code: 'HTTP_ERROR', message: 'Bazaar not found.' });
  });

  it.each([
    ['P2002', 409, 'UNIQUE_VIOLATION'],
    ['P2003', 400, 'INVALID_REFERENCE'],
    ['P2025', 404, 'NOT_FOUND'],
  ])('maps Prisma %s to %i %s (ERR-02)', (code, httpStatus, expectedCode) => {
    const { host, status, json } = hostWith();
    const error = new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 't', meta: { target: ['email'] } });
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(httpStatus);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: expectedCode }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a CHECK constraint violation (SQLSTATE 23514) is 409 CONSTRAINT_VIOLATION, not a 500 (commerce/25 S2)', () => {
    const { host, status, json } = hostWith();
    const error = new Prisma.PrismaClientUnknownRequestError(
      'ConnectorError(... PostgresError { code: "23514", message: "new row for relation \\"product_variants\\" violates check constraint ..." })',
      { clientVersion: 't' },
    );
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONSTRAINT_VIOLATION' }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a serialization failure that outlived its retries (P2034)', new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 't' })],
    ['a deadlock from a raw query (P2010 / 40P01)', new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 't', meta: { code: '40P01' } })],
    ['a lock timeout (55P03)', new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 't', meta: { code: '55P03' } })],
    ['a transaction timeout (P2028)', new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: 't' })],
    ['a statement timeout (57014)', new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 't', meta: { code: '57014' } })],
  ])('%s is a coded, retryable 503 SERVICE_BUSY, never a 500 (commerce/25 §11)', (_label, error) => {
    const { host, status, json } = hostWith();
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVICE_BUSY' }));
  });

  it('other unknown Prisma errors stay a logged 500', () => {
    const { host, status } = hostWith();
    filter.catch(new Prisma.PrismaClientUnknownRequestError('connection reset', { clientVersion: 't' }), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('unknown errors are a generic 500 AND are logged with the stack and user (LOG-02)', () => {
    const { host, status, json } = hostWith({ user: { id: 'user-9' } });
    const boom = new Error('db down');
    filter.catch(boom, host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('GET /x -> 500 INTERNAL_SERVER_ERROR (user user-9)');
    expect(errorSpy.mock.calls[0][1]).toBe(boom.stack);
  });

  it('does not log 4xx', () => {
    const { host } = hostWith();
    filter.catch(new BadRequestException({ code: 'VALIDATION_ERROR', message: [] }), host);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
