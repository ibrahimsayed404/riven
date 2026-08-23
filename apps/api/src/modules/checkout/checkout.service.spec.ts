import { Test, TestingModule } from '@nestjs/testing';
import { CheckoutService, OutOfStockError } from './checkout.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProductsRepository } from '../products/products.repository';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('CheckoutService', () => {
  let service: CheckoutService;
  let prisma: jest.Mocked<PrismaService>;
  let productsRepo: jest.Mocked<ProductsRepository>;

  const mockUserId = 'user-1';

  beforeEach(async () => {
    const mockPrisma = {
      cart: { findUnique: jest.fn() },
      product: { findMany: jest.fn() },
      $transaction: jest.fn(),
    };

    const mockProductsRepo = {
      visibilityFilter: { isActive: true },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ProductsRepository, useValue: mockProductsRepo },
      ],
    }).compile();

    service = module.get<CheckoutService>(CheckoutService);
    prisma = module.get(PrismaService) as any;
    productsRepo = module.get(ProductsRepository) as any;
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

  it('should handle transaction success and return result', async () => {
    (prisma.cart.findUnique as jest.Mock).mockResolvedValue({
      items: [
        { id: 'item-1', productId: 'prod-1', quantity: 1, product: { vendorId: 'v-1' }, variant: { stockQuantity: 5 } },
      ],
    } as any);

    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod-1' }] as any);
    (prisma.$transaction as jest.Mock).mockResolvedValue({ id: 'group-1', orders: [] });

    const result = await service.checkoutCart(mockUserId);
    expect(result).toEqual({ id: 'group-1', orders: [] });
    expect(prisma.$transaction).toHaveBeenCalled();
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
});
