import { Test, TestingModule } from '@nestjs/testing';
import { CheckoutService, OutOfStockError } from './checkout.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProductsRepository } from '../products/products.repository';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PaymobService } from '../../infra/paymob/paymob.service';

describe('CheckoutService', () => {
  let service: CheckoutService;
  let prisma: jest.Mocked<PrismaService>;
  let productsRepo: jest.Mocked<ProductsRepository>;
  let paymobService: jest.Mocked<PaymobService>;

  const mockUserId = 'user-1';

  beforeEach(async () => {
    const mockPrisma = {
      cart: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      orderGroup: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };

    const mockProductsRepo = {
      visibilityFilter: { isActive: true },
    };

    const mockPaymobService = {
      createIntention: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ProductsRepository, useValue: mockProductsRepo },
        { provide: PaymobService, useValue: mockPaymobService },
      ],
    }).compile();

    service = module.get<CheckoutService>(CheckoutService);
    prisma = module.get(PrismaService) as any;
    productsRepo = module.get(ProductsRepository) as any;
    paymobService = module.get(PaymobService) as any;
  });

  it('should throw BadRequestException if cart is empty', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({ items: [] } as any);
    await expect(service.checkoutCart(mockUserId)).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException if item is no longer visible', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [{ id: 'item-1', productId: 'prod-1', quantity: 1, variant: { stockQuantity: 5 } }],
    } as any);

    // Return empty array meaning no visible products found
    (prisma.product.findMany as jest.Mock).mockResolvedValue([]);

    await expect(service.checkoutCart(mockUserId)).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException if requested quantity exceeds stock', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [{ id: 'item-1', productId: 'prod-1', quantity: 10, variant: { stockQuantity: 5 } }],
    } as any);

    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod-1' }] as any);

    await expect(service.checkoutCart(mockUserId)).rejects.toThrow(BadRequestException);
  });

  it('should handle transaction success and return result with Paymob intent', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [
        { id: 'item-1', productId: 'prod-1', quantity: 1, product: { vendorId: 'v-1' }, variant: { stockQuantity: 5 } },
      ],
    } as any);

    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod-1' }] as any);
    (prisma.$transaction as jest.Mock).mockResolvedValue({ id: 'group-1', orders: [{ subtotal: 1000 }] });
    
    paymobService.createIntention.mockResolvedValue({ intentId: 'intent-123', clientUrl: 'url' });

    const result = await service.checkoutCart(mockUserId);
    expect(result.id).toBe('group-1');
    expect(result.paymobIntentId).toBe('intent-123');
    expect(result.paymentSetupFailed).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(paymobService.createIntention).toHaveBeenCalledWith(1000, 'group-1');
    expect(prisma.orderGroup.update).toHaveBeenCalledWith({
      where: { id: 'group-1' },
      data: { paymobIntentId: 'intent-123' },
    });
  });

  it('should return result with paymentSetupFailed if Paymob intent creation fails', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [
        { id: 'item-1', productId: 'prod-1', quantity: 1, product: { vendorId: 'v-1' }, variant: { stockQuantity: 5 } },
      ],
    } as any);

    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod-1' }] as any);
    (prisma.$transaction as jest.Mock).mockResolvedValue({ id: 'group-1', orders: [{ subtotal: 1000 }] });
    
    paymobService.createIntention.mockRejectedValue(new Error('Paymob API Down'));

    const result = await service.checkoutCart(mockUserId);
    expect(result.id).toBe('group-1');
    expect(result.paymentSetupFailed).toBe(true);
    expect(result.paymobIntentId).toBeUndefined(); // Didn't succeed
  });

  it('should catch OutOfStockError from inside transaction and throw BadRequest', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [
        { id: 'item-1', productId: 'prod-1', quantity: 1, product: { vendorId: 'v-1' }, variant: { stockQuantity: 5 } },
      ],
    } as any);

    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod-1' }] as any);
    
    (prisma.$transaction as jest.Mock).mockRejectedValue(new OutOfStockError('var-1'));

    await expect(service.checkoutCart(mockUserId)).rejects.toThrow(BadRequestException);
  });

  it('should retry on P2034 serialization failure up to 3 times', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [
        { id: 'item-1', productId: 'prod-1', quantity: 1, product: { vendorId: 'v-1' }, variant: { stockQuantity: 5 } },
      ],
    } as any);

    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod-1' }] as any);
    
    const serializationError = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '5' });
    (prisma.$transaction as jest.Mock).mockRejectedValue(serializationError);

    await expect(service.checkoutCart(mockUserId)).rejects.toThrow('System is experiencing high load. Please try again later.');
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  describe('retryPaymentSetup', () => {
    it('should throw if order group not found', async () => {
      (prisma.orderGroup.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.retryPaymentSetup('user-1', 'group-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw if order group belongs to different user', async () => {
      (prisma.orderGroup.findUnique as jest.Mock).mockResolvedValue({ userId: 'user-2' });
      await expect(service.retryPaymentSetup('user-1', 'group-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw if already has a paymob intent', async () => {
      (prisma.orderGroup.findUnique as jest.Mock).mockResolvedValue({ userId: 'user-1', paymobIntentId: 'existing-intent' });
      await expect(service.retryPaymentSetup('user-1', 'group-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw if any order is not PENDING', async () => {
      (prisma.orderGroup.findUnique as jest.Mock).mockResolvedValue({
        userId: 'user-1',
        paymobIntentId: null,
        orders: [{ status: 'PAID' }],
      });
      await expect(service.retryPaymentSetup('user-1', 'group-1')).rejects.toThrow(BadRequestException);
    });

    it('should create intention and update order group on success', async () => {
      (prisma.orderGroup.findUnique as jest.Mock).mockResolvedValue({
        id: 'group-1',
        userId: 'user-1',
        paymobIntentId: null,
        orders: [{ status: 'PENDING', subtotal: 1000 }],
      });
      
      paymobService.createIntention.mockResolvedValue({ intentId: 'intent-new', clientUrl: 'url' });

      const result = await service.retryPaymentSetup('user-1', 'group-1');
      
      expect(result.paymobIntentId).toBe('intent-new');
      expect(result.clientUrl).toBe('url');
      expect(paymobService.createIntention).toHaveBeenCalledWith(1000, 'group-1');
      expect(prisma.orderGroup.update).toHaveBeenCalledWith({
        where: { id: 'group-1' },
        data: { paymobIntentId: 'intent-new' },
      });
    });
  });
});
