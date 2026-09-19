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
      throw new BadRequestException({ code: 'INVALID_QUANTITY', message: 'Quantity must be greater than 0.' });
    }

    // Lazily create cart if it doesn't exist
    const cart = await this.cartRepository.findOrCreateCart(userId);

    // Validate product/variant visibility and stock (soft check)
    const product = await this.cartRepository.getProductWithVariant(productId, variantId);

    if (!product || product.variants.length === 0) {
      throw new NotFoundException({
        code: 'PRODUCT_UNAVAILABLE',
        message: 'Product or variant not found, or not available.',
      });
    }

    const variant = product.variants[0];
    const existingItem = cart.items.find(i => i.variantId === variantId);
    const existingQuantity = existingItem ? existingItem.quantity : 0;

    this.assertWithinStock(existingQuantity + quantity, variant.stockQuantity, existingQuantity);

    // Upsert the item
    return this.cartRepository.upsertCartItem(cart.id, productId, variantId, quantity);
  }

  async updateItemQuantity(userId: string, itemId: string, quantity: number) {
    if (quantity < 0) {
      throw new BadRequestException({ code: 'INVALID_QUANTITY', message: 'Quantity cannot be negative.' });
    }

    const item = await this.cartRepository.getCartItem(itemId);
    if (!item) {
      throw cartItemNotFound();
    }

    const cart = await this.cartRepository.getCart(userId);
    if (!cart || item.cartId !== cart.id) {
      throw cartItemNotFound();
    }

    if (quantity === 0) {
      await this.cartRepository.removeCartItem(itemId);
      return { deleted: true };
    }

    // Same stock rule as addItem — the cart must never show an impossible
    // quantity that checkout will then reject (fix.js LOGIC-06).
    const line = cart.items.find((i) => i.id === itemId);
    if (line) {
      this.assertWithinStock(quantity, line.variant.stockQuantity, 0);
    }

    return this.cartRepository.updateCartItemQuantity(itemId, quantity);
  }

  async removeItem(userId: string, itemId: string) {
    const item = await this.cartRepository.getCartItem(itemId);
    if (!item) {
      throw cartItemNotFound();
    }

    const cart = await this.cartRepository.getCart(userId);
    if (!cart || item.cartId !== cart.id) {
      throw cartItemNotFound();
    }

    await this.cartRepository.removeCartItem(itemId);
  }

  async clearCart(userId: string) {
    const cart = await this.cartRepository.getCart(userId);
    if (cart) {
      await this.cartRepository.clearCart(cart.id);
    }
  }

  private assertWithinStock(requested: number, inStock: number, alreadyInCart: number): void {
    if (requested > inStock) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_STOCK',
        message: alreadyInCart
          ? `Cannot add that many. You already have ${alreadyInCart} in your cart and only ${inStock} are in stock.`
          : `Only ${inStock} in stock.`,
        details: { inStock, alreadyInCart },
      });
    }
  }
}

const cartItemNotFound = () =>
  new NotFoundException({ code: 'CART_ITEM_NOT_FOUND', message: 'Cart item not found in your cart.' });
