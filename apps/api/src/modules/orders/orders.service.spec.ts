import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let repository: jest.Mocked<OrdersRepository>;

  beforeEach(() => {
    repository = {
      getShopperOrder: jest.fn(),
      getVendorOrder: jest.fn(),
      transitionOrderStatus: jest.fn(),
      cancelPendingGroup: jest.fn(),
      findStalePendingGroupIds: jest.fn(),
      findShopperOrders: jest.fn(),
      findVendorOrders: jest.fn(),
      hasDeliveredVendorOrder: jest.fn(),
      hasDeliveredProductOrder: jest.fn(),
      groupByStatus: jest.fn(),
      findManyForAdmin: jest.fn(),
      findByIdForAdmin: jest.fn(),
    } as unknown as jest.Mocked<OrdersRepository>;
    service = new OrdersService(repository);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('cancelOrder (group-level, PAY-01 / PAY-03)', () => {
    it('refuses with ORDER_NOT_CANCELLABLE when the order is not PENDING', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', orderGroupId: 'g', status: OrderStatus.PAID } as any);

      await expect(service.cancelOrder('user-1', '1')).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_CANCELLABLE' },
      });
      expect(repository.cancelPendingGroup).not.toHaveBeenCalled();
    });

    it('cancels the whole PENDING group and returns the cancelled ids', async () => {
      repository.getShopperOrder
        .mockResolvedValueOnce({ id: '1', orderGroupId: 'g', status: OrderStatus.PENDING } as any)
        .mockResolvedValueOnce({ id: '1', orderGroupId: 'g', status: OrderStatus.CANCELLED } as any);
      repository.cancelPendingGroup.mockResolvedValue({ cancelledOrderIds: ['1', '2'] });

      const res = await service.cancelOrder('user-1', '1');

      expect(repository.cancelPendingGroup).toHaveBeenCalledWith('g');
      expect(res.status).toBe(OrderStatus.CANCELLED);
      expect(res.cancelledOrderIds).toEqual(['1', '2']);
    });

    it('409 ORDER_STATE_CHANGED when the webhook paid it between the read and the guarded write (PAY-05)', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', orderGroupId: 'g', status: OrderStatus.PENDING } as any);
      repository.cancelPendingGroup.mockResolvedValue({ cancelledOrderIds: [] });

      await expect(service.cancelOrder('user-1', '1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('404 with ORDER_NOT_FOUND for another user\'s order', async () => {
      repository.getShopperOrder.mockResolvedValue(null);
      await expect(service.cancelOrder('user-1', '1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateVendorOrderStatus', () => {
    it('should throw BadRequest if vendor tries to transition to an unauthorized state', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PENDING } as any);
      await expect(service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.DELIVERED)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequest if transition is logically invalid (e.g., PENDING to SHIPPED)', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PENDING } as any);
      await expect(service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.SHIPPED)).rejects.toMatchObject({
        response: { code: 'INVALID_ORDER_TRANSITION' },
      });
    });

    it('uses a conditional write from the observed status (PAID -> FULFILLED)', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PAID } as any);
      repository.transitionOrderStatus.mockResolvedValue({ id: '1', status: OrderStatus.FULFILLED } as any);

      const res = await service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.FULFILLED);

      expect(repository.transitionOrderStatus).toHaveBeenCalledWith('1', OrderStatus.PAID, OrderStatus.FULFILLED);
      expect(res.status).toBe(OrderStatus.FULFILLED);
    });

    it('409 when the conditional write matched nothing', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PAID } as any);
      repository.transitionOrderStatus.mockResolvedValue(null);
      await expect(service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.FULFILLED)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('confirmDelivery', () => {
    it('should throw BadRequest if not SHIPPED', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', status: OrderStatus.FULFILLED } as any);
      await expect(service.confirmDelivery('user-1', '1')).rejects.toMatchObject({ response: { code: 'ORDER_NOT_SHIPPED' } });
    });

    it('should transition SHIPPED to DELIVERED conditionally', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', status: OrderStatus.SHIPPED } as any);
      repository.transitionOrderStatus.mockResolvedValue({ id: '1', status: OrderStatus.DELIVERED } as any);

      const res = await service.confirmDelivery('user-1', '1');
      expect(repository.transitionOrderStatus).toHaveBeenCalledWith('1', OrderStatus.SHIPPED, OrderStatus.DELIVERED);
      expect(res.status).toBe(OrderStatus.DELIVERED);
    });
  });

  describe('expireStalePendingGroups (PAY-03)', () => {
    it('cancels each stale group and reports counts', async () => {
      repository.findStalePendingGroupIds.mockResolvedValue(['g1', 'g2']);
      repository.cancelPendingGroup.mockResolvedValueOnce({ cancelledOrderIds: ['a', 'b'] }).mockResolvedValueOnce({ cancelledOrderIds: ['c'] });

      const result = await service.expireStalePendingGroups(60);

      const [olderThan, take] = repository.findStalePendingGroupIds.mock.calls[0];
      expect(Date.now() - olderThan.getTime()).toBeGreaterThanOrEqual(60 * 60_000 - 1000);
      expect(take).toBe(100);
      expect(result).toEqual({ groups: 2, orders: 3 });
    });

    it('is a quiet no-op when nothing is stale', async () => {
      repository.findStalePendingGroupIds.mockResolvedValue([]);
      await expect(service.expireStalePendingGroups(60)).resolves.toEqual({ groups: 0, orders: 0 });
      expect(repository.cancelPendingGroup).not.toHaveBeenCalled();
    });
  });

  describe('list wrappers return { data, meta }', () => {
    it('shopper', async () => {
      repository.findShopperOrders.mockResolvedValue({ data: [], total: 5 });
      await expect(service.getShopperOrders('u', 2, 2)).resolves.toEqual({ data: [], meta: { total: 5, page: 2, limit: 2, totalPages: 3 } });
    });
    it('vendor', async () => {
      repository.findVendorOrders.mockResolvedValue({ data: [], total: 0 });
      await expect(service.getVendorOrders('v', 1, 20)).resolves.toEqual({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    });
  });

  describe('verifyDeliveredPurchase', () => {
    it('calls hasDeliveredVendorOrder for VENDOR targetType', async () => {
      repository.hasDeliveredVendorOrder.mockResolvedValue(true);
      await expect(service.verifyDeliveredPurchase('u', 'o', 'VENDOR', 'v')).resolves.toBe(true);
      expect(repository.hasDeliveredVendorOrder).toHaveBeenCalledWith('u', 'o', 'v');
    });

    it('calls hasDeliveredProductOrder for PRODUCT targetType', async () => {
      repository.hasDeliveredProductOrder.mockResolvedValue(false);
      await expect(service.verifyDeliveredPurchase('u', 'o', 'PRODUCT', 'p')).resolves.toBe(false);
      expect(repository.hasDeliveredProductOrder).toHaveBeenCalledWith('u', 'o', 'p');
    });

    it('returns false for unsupported target types (BAZAAR / EVENT — see fix.js SPEC-03)', async () => {
      await expect(service.verifyDeliveredPurchase('u', 'o', 'BAZAAR', 'b')).resolves.toBe(false);
      await expect(service.verifyDeliveredPurchase('u', 'o', 'EVENT', 'e')).resolves.toBe(false);
    });
  });

  describe('admin reads (specs/admin-module-spec2.md A5)', () => {
    it('listForAdmin passes every filter through with no user/vendor scope and wraps { data, meta }', async () => {
      repository.findManyForAdmin.mockResolvedValue({ data: [{ id: 'o1' }] as any, total: 45 });

      const params = { status: OrderStatus.PAID, vendorId: 'v', userId: 'u', orderGroupId: 'g', page: 2, limit: 20 };
      const result = await service.listForAdmin(params);

      expect(repository.findManyForAdmin).toHaveBeenCalledWith(params);
      expect(repository.findShopperOrders).not.toHaveBeenCalled();
      expect(repository.findVendorOrders).not.toHaveBeenCalled();
      expect(result.meta).toEqual({ total: 45, page: 2, limit: 20, totalPages: 3 });
    });

    it('getOrderForAdmin returns any order without an owner check', async () => {
      const order = { id: 'o1', status: OrderStatus.SHIPPED, items: [], orderGroup: { id: 'g' } };
      repository.findByIdForAdmin.mockResolvedValue(order as any);

      await expect(service.getOrderForAdmin('o1')).resolves.toBe(order);
      expect(repository.getShopperOrder).not.toHaveBeenCalled();
      expect(repository.getVendorOrder).not.toHaveBeenCalled();
    });

    it('getOrderForAdmin throws a coded 404 for an unknown id', async () => {
      repository.findByIdForAdmin.mockResolvedValue(null);

      await expect(service.getOrderForAdmin('missing')).rejects.toMatchObject({ response: { code: 'ORDER_NOT_FOUND' } });
    });
  });
});
