import { Injectable } from '@nestjs/common';
import { Cart, CartItem, Product, ProductVariant } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ACTIVE_VARIANT_WHERE, PUBLIC_PRODUCT_WHERE } from '../products/product-visibility';

export type CartItemWithDetails = CartItem & {
  product: Product;
  variant: ProductVariant;
};

export type CartWithItems = Cart & {
  items: CartItemWithDetails[];
};

@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateCart(userId: string): Promise<CartWithItems> {
    const cart = await this.prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
      include: {
        items: {
          include: {
            product: true,
            variant: true,
          },
        },
      },
    });
    return cart;
  }

  async getCart(userId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: true,
            variant: true,
          },
        },
      },
    });
  }

  async upsertCartItem(
    cartId: string,
    productId: string,
    variantId: string,
    quantity: number,
  ): Promise<CartItem> {
    return this.prisma.cartItem.upsert({
      where: {
        cartId_variantId: {
          cartId,
          variantId,
        },
      },
      update: {
        quantity: {
          increment: quantity,
        },
      },
      create: {
        cartId,
        productId,
        variantId,
        quantity,
      },
    });
  }

  async updateCartItemQuantity(itemId: string, quantity: number): Promise<CartItem> {
    return this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity },
    });
  }

  async removeCartItem(itemId: string): Promise<void> {
    await this.prisma.cartItem.delete({
      where: { id: itemId },
    });
  }

  async clearCart(cartId: string): Promise<void> {
    await this.prisma.cartItem.deleteMany({
      where: { cartId },
    });
  }

  async getCartItem(itemId: string): Promise<CartItem | null> {
    return this.prisma.cartItem.findUnique({
      where: { id: itemId },
    });
  }

  async getProductWithVariant(
    productId: string,
    variantId: string,
  ): Promise<(Product & { variants: ProductVariant[] }) | null> {
    return this.prisma.product.findFirst({
      where: {
        id: productId,
        ...PUBLIC_PRODUCT_WHERE,
        variants: {
          some: { id: variantId, ...ACTIVE_VARIANT_WHERE },
        },
      },
      include: {
        variants: {
          where: { id: variantId, ...ACTIVE_VARIANT_WHERE },
        },
      },
    });
  }
}
