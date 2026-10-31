import { autoMock, expectPassThrough, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { CheckoutController } from './checkout.controller';

// Unit tests for every route of CheckoutController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('CheckoutController (unit)', () => {
  let checkoutService: ReturnType<typeof autoMock>;
  let controller: CheckoutController;

  beforeEach(() => {
    checkoutService = autoMock('checkoutService');
    controller = new CheckoutController(checkoutService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(CheckoutController)).toEqual([
      {
        "handler": "checkout",
        "method": "POST",
        "path": "/checkout",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "retryPayment",
        "method": "POST",
        "path": "/checkout/:orderGroupId/retry-payment",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      }
    ]);
  });

  it('POST /checkout → checkoutService.checkoutCart', async () => {
    const userId = userOf(Role.SHOPPER).id;
    await controller.checkout(userId);
    expect(checkoutService.checkoutCart).toHaveBeenLastCalledWith(userId, undefined); // no header: unchanged behaviour
    const result = await controller.checkout(userId, 'key-0123456789');
    expect(checkoutService.checkoutCart).toHaveBeenLastCalledWith(userId, 'key-0123456789'); // Idempotency-Key passed through (commerce/25 S4)
    expect(checkoutService.checkoutCart).toHaveBeenCalledTimes(2);
    await expectPassThrough(result, checkoutService.checkoutCart);
  });

  it('POST /checkout/:orderGroupId/retry-payment → checkoutService.retryPaymentSetup', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const orderGroupId = 'orderGroupId-1';
    const result = await controller.retryPayment(userId, orderGroupId);
    expect(checkoutService.retryPaymentSetup).toHaveBeenCalledWith(userId, orderGroupId);
    expect(checkoutService.retryPaymentSetup).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, checkoutService.retryPaymentSetup);
  });
});
