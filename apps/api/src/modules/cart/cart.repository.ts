import { Injectable } from '@nestjs/common';
import { Cart, CartItem, Prisma, Product, ProductVariant } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  ACTIVE_VARIANT_WHERE,
  PUBLIC_PRODUCT_SELECT,
  PUBLIC_PRODUCT_WHERE,
  PUBLIC_VARIANT_SELECT,
} from '../products/product-visibility';

// The cart is a shopper view: it carries the same public product/variant
// fields as GET /products/:id, never moderation or soft-delete bookkeeping.
const cartItemInclude = {
  product: { select: PUBLIC_PRODUCT_SELECT },
  variant: { select: PUBLIC_VARIANT_SELECT },
} satisfies Prisma.CartItemInclude;

export type CartItemWithDetails = CartItem & {
  product: Prisma.ProductGetPayload<{ select: typeof PUBLIC_PRODUCT_SELECT }>;
  variant: Prisma.ProductVariantGetPayload<{ select: typeof PUBLIC_VARIANT_SELECT }>;
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
        items: { include: cartItemInclude },
      },
    });
    return cart;
  }

  async getCart(userId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: { include: cartItemInclude },
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
