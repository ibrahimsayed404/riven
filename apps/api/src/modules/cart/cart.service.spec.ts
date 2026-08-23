import { Test, TestingModule } from '@nestjs/testing';
import { CartService } from './cart.service';
import { CartRepository } from './cart.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('CartService', () => {
  let service: CartService;
  let cartRepository: jest.Mocked<CartRepository>;

  const mockUserId = 'user-1';
  const mockProductId = 'product-1';
  const mockVariantId = 'variant-1';
  const mockCartId = 'cart-1';

  beforeEach(async () => {
    const mockRepo = {
      getCart: jest.fn(),
      findOrCreateCart: jest.fn(),
      getProductWithVariant: jest.fn(),
      upsertCartItem: jest.fn(),
      getCartItem: jest.fn(),
      updateCartItemQuantity: jest.fn(),
      removeCartItem: jest.fn(),
      clearCart: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        {
          provide: CartRepository,
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<CartService>(CartService);
    cartRepository = module.get(CartRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getCart', () => {
    it('should return empty shaped cart if none exists', async () => {
      cartRepository.getCart.mockResolvedValue(null);
      const cart = await service.getCart(mockUserId);
      expect(cart.userId).toBe(mockUserId);
      expect(cart.items).toEqual([]);
    });
  });

  describe('addItem', () => {
    it('should throw BadRequestException if quantity <= 0', async () => {
      await expect(service.addItem(mockUserId, mockProductId, mockVariantId, 0))
        .rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if product/variant is not found or visible', async () => {
      cartRepository.findOrCreateCart.mockResolvedValue({ id: mockCartId, items: [] } as any);
      cartRepository.getProductWithVariant.mockResolvedValue(null);
      
      await expect(service.addItem(mockUserId, mockProductId, mockVariantId, 1))
        .rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if requested quantity exceeds stock', async () => {
      cartRepository.findOrCreateCart.mockResolvedValue({ id: mockCartId, items: [] } as any);
      cartRepository.getProductWithVariant.mockResolvedValue({
        variants: [{ id: mockVariantId, stockQuantity: 5 }],
      } as any);

      await expect(service.addItem(mockUserId, mockProductId, mockVariantId, 10))
        .rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if total quantity (existing + new) exceeds stock', async () => {
      cartRepository.findOrCreateCart.mockResolvedValue({
        id: mockCartId,
        items: [{ variantId: mockVariantId, quantity: 4 }],
      } as any);
      cartRepository.getProductWithVariant.mockResolvedValue({
        variants: [{ id: mockVariantId, stockQuantity: 5 }],
      } as any);

      await expect(service.addItem(mockUserId, mockProductId, mockVariantId, 2))
        .rejects.toThrow(BadRequestException);
    });

    it('should upsert the cart item successfully if valid', async () => {
      cartRepository.findOrCreateCart.mockResolvedValue({ id: mockCartId, items: [] } as any);
      cartRepository.getProductWithVariant.mockResolvedValue({
        variants: [{ id: mockVariantId, stockQuantity: 5 }],
      } as any);
      
      const mockResult = { id: 'item-1', quantity: 2 } as any;
      cartRepository.upsertCartItem.mockResolvedValue(mockResult);

      const result = await service.addItem(mockUserId, mockProductId, mockVariantId, 2);
      expect(result).toEqual(mockResult);
      expect(cartRepository.upsertCartItem).toHaveBeenCalledWith(mockCartId, mockProductId, mockVariantId, 2);
    });
  });

  describe('updateItemQuantity', () => {
    it('should throw BadRequestException for negative quantity', async () => {
      await expect(service.updateItemQuantity(mockUserId, 'item-1', -1))
        .rejects.toThrow(BadRequestException);
    });

    it('should remove item if quantity is 0', async () => {
      cartRepository.getCartItem.mockResolvedValue({ id: 'item-1', cartId: mockCartId } as any);
      cartRepository.getCart.mockResolvedValue({ id: mockCartId } as any);
      
      const res = await service.updateItemQuantity(mockUserId, 'item-1', 0);
      expect(res).toEqual({ deleted: true });
      expect(cartRepository.removeCartItem).toHaveBeenCalledWith('item-1');
    });
  });
});
