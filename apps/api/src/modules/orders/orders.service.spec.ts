import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { OrdersRepository } from './orders.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

describe('OrdersService', () => {
  let service: OrdersService;
  let repository: jest.Mocked<OrdersRepository>;

  beforeEach(async () => {
    const mockRepo = {
      getShopperOrder: jest.fn(),
      getVendorOrder: jest.fn(),
      updateOrderStatus: jest.fn(),
      findShopperOrders: jest.fn(),
      findVendorOrders: jest.fn(),
      hasDeliveredVendorOrder: jest.fn(),
      hasDeliveredProductOrder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: OrdersRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    repository = module.get(OrdersRepository);
  });

  describe('cancelOrder', () => {
    it('should throw BadRequest if order is not PENDING', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', status: OrderStatus.PAID } as any);
      
      await expect(service.cancelOrder('user-1', '1'))
        .rejects.toThrow(BadRequestException);
    });

    it('should update status to CANCELLED if PENDING', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', status: OrderStatus.PENDING } as any);
      repository.updateOrderStatus.mockResolvedValue({ id: '1', status: OrderStatus.CANCELLED } as any);

      const res = await service.cancelOrder('user-1', '1');
      expect(res.status).toBe(OrderStatus.CANCELLED);
      expect(repository.updateOrderStatus).toHaveBeenCalledWith('1', OrderStatus.CANCELLED);
    });
  });

  describe('updateVendorOrderStatus', () => {
    it('should throw BadRequest if vendor tries to transition to an unauthorized state', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PENDING } as any);
      
      // Vendors shouldn't be able to transition to DELIVERED
      await expect(service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.DELIVERED))
        .rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequest if transition is logically invalid (e.g., PENDING to SHIPPED)', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PENDING } as any);
      
      // Even though vendors can transition to SHIPPED in general, it's invalid to go PENDING -> SHIPPED
      await expect(service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.SHIPPED))
        .rejects.toThrow(BadRequestException);
    });

    it('should succeed for valid transition (PAID to FULFILLED)', async () => {
      repository.getVendorOrder.mockResolvedValue({ id: '1', status: OrderStatus.PAID } as any);
      repository.updateOrderStatus.mockResolvedValue({ id: '1', status: OrderStatus.FULFILLED } as any);
      
      const res = await service.updateVendorOrderStatus('vendor-1', '1', OrderStatus.FULFILLED);
      expect(res.status).toBe(OrderStatus.FULFILLED);
    });
  });

  describe('confirmDelivery', () => {
    it('should throw BadRequest if not SHIPPED', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', status: OrderStatus.FULFILLED } as any);
      await expect(service.confirmDelivery('user-1', '1'))
        .rejects.toThrow(BadRequestException);
    });

    it('should transition SHIPPED to DELIVERED', async () => {
      repository.getShopperOrder.mockResolvedValue({ id: '1', status: OrderStatus.SHIPPED } as any);
      repository.updateOrderStatus.mockResolvedValue({ id: '1', status: OrderStatus.DELIVERED } as any);

      const res = await service.confirmDelivery('user-1', '1');
      expect(res.status).toBe(OrderStatus.DELIVERED);
    });
  });

  describe('verifyDeliveredPurchase', () => {
    it('calls hasDeliveredVendorOrder for VENDOR targetType', async () => {
      repository.hasDeliveredVendorOrder.mockResolvedValue(true);

      const result = await service.verifyDeliveredPurchase(
        'user-1',
        'order-1',
        'VENDOR' as any,
        'vendor-1',
      );

      expect(result).toBe(true);
      expect(repository.hasDeliveredVendorOrder).toHaveBeenCalledWith(
        'user-1',
        'order-1',
        'vendor-1',
      );
    });

    it('calls hasDeliveredProductOrder for PRODUCT targetType', async () => {
      repository.hasDeliveredProductOrder.mockResolvedValue(true);

      const result = await service.verifyDeliveredPurchase(
        'user-1',
        'order-1',
        'PRODUCT' as any,
        'prod-1',
      );

      expect(result).toBe(true);
      expect(repository.hasDeliveredProductOrder).toHaveBeenCalledWith(
        'user-1',
        'order-1',
        'prod-1',
      );
    });

    it('returns false for unsupported target types', async () => {
      const result = await service.verifyDeliveredPurchase(
        'user-1',
        'order-1',
        'BAZAAR' as any,
        'bazaar-1',
      );

      expect(result).toBe(false);
    });
  });
});
