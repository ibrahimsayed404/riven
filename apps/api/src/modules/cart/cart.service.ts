import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CartRepository, CartWithItems } from './cart.repository';

@Injectable()
export class CartService {
  constructor(private readonly cartRepository: CartRepository) {}

  async getCart(userId: string): Promise<CartWithItems> {
    const cart = await this.cartRepository.getCart(userId);
    if (!cart) {
      // Lazily return an empty-shape cart without persisting it if it doesn't exist
      return {
        id: '',
        userId,
        updatedAt: new Date(),
        items: [],
      } as CartWithItems;
    }
    return cart;
  }

  async addItem(
    userId: string,
    productId: string,
    variantId: string,
    quantity: number,
  ) {
    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than 0');
    }

    // Lazily create cart if it doesn't exist
    const cart = await this.cartRepository.findOrCreateCart(userId);

    // Validate product/variant visibility and stock (soft check)
    const product = await this.cartRepository.getProductWithVariant(productId, variantId);
    
    if (!product || product.variants.length === 0) {
      throw new NotFoundException('Product or variant not found, or not available');
    }
    
    const variant = product.variants[0];
    const existingItem = cart.items.find(i => i.variantId === variantId);
    const existingQuantity = existingItem ? existingItem.quantity : 0;
    
    if (existingQuantity + quantity > variant.stockQuantity) {
      throw new BadRequestException(`Cannot add ${quantity} items. You already have ${existingQuantity} in cart. Only ${variant.stockQuantity} in stock.`);
    }

    // Upsert the item
    return this.cartRepository.upsertCartItem(cart.id, productId, variantId, quantity);
  }

  async updateItemQuantity(userId: string, itemId: string, quantity: number) {
    if (quantity < 0) {
      throw new BadRequestException('Quantity cannot be negative');
    }

    const item = await this.cartRepository.getCartItem(itemId);
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    const cart = await this.cartRepository.getCart(userId);
    if (!cart || item.cartId !== cart.id) {
      throw new NotFoundException('Cart item not found in your cart');
    }

    if (quantity === 0) {
      await this.cartRepository.removeCartItem(itemId);
      return { deleted: true };
    }

    return this.cartRepository.updateCartItemQuantity(itemId, quantity);
  }

  async removeItem(userId: string, itemId: string) {
    const item = await this.cartRepository.getCartItem(itemId);
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    const cart = await this.cartRepository.getCart(userId);
    if (!cart || item.cartId !== cart.id) {
      throw new NotFoundException('Cart item not found in your cart');
    }

    await this.cartRepository.removeCartItem(itemId);
  }

  async clearCart(userId: string) {
    const cart = await this.cartRepository.getCart(userId);
    if (cart) {
      await this.cartRepository.clearCart(cart.id);
    }
  }
}
