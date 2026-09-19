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
