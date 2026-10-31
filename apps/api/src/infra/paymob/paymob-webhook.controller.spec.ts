import { autoMock, expectPassThrough, routesOf } from '../../test-utils/controller-test.helpers';

import { PaymobWebhookController } from './paymob-webhook.controller';

// Unit tests for every route of PaymobWebhookController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('PaymobWebhookController (unit)', () => {
  let dispatcher: ReturnType<typeof autoMock>;
  let controller: PaymobWebhookController;

  beforeEach(() => {
    dispatcher = autoMock('dispatcher');
    controller = new PaymobWebhookController(dispatcher as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(PaymobWebhookController)).toEqual([
      {
        "handler": "handleWebhook",
        "method": "POST",
        "path": "/webhooks/paymob",
        "guards": [],
        "httpCode": 200
      }
    ]);
  });
  // manual tests (handlers whose body is more than one service call)
  it('POST /webhooks/paymob → dispatcher.dispatch(payload, header HMAC first, query HMAC as fallback)', async () => {
    const payload = { obj: { id: 1 } };
    await controller.handleWebhook(payload, 'header-hmac', 'query-hmac');
    expect(dispatcher.dispatch).toHaveBeenLastCalledWith(payload, 'header-hmac');
    const result = await controller.handleWebhook(payload, undefined, 'query-hmac');
    expect(dispatcher.dispatch).toHaveBeenLastCalledWith(payload, 'query-hmac');
    await expectPassThrough(result, dispatcher.dispatch);
    await controller.handleWebhook(payload);
    expect(dispatcher.dispatch).toHaveBeenLastCalledWith(payload, undefined);
  });
});
