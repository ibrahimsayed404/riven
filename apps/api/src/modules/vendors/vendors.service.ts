import { Injectable, NotFoundException, HttpException, HttpStatus, ForbiddenException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { VendorsRepository } from './vendors.repository';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { UpdateVendorLocationDto } from './dto/update-vendor-location.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateProductVariantDto } from './dto/create-product-variant.dto';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto';

const LOCATION_UPDATE_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class VendorsService {
  private locationUpdateTimestamps = new Map<string, number>();

  constructor(private readonly vendorsRepository: VendorsRepository) {}

  async getMyProfile(ownerId: string) {
    const vendor = await this.vendorsRepository.findByOwnerId(ownerId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }
    const location = await this.vendorsRepository.findVendorLocation(vendor.id);
    return { ...vendor, location };
  }

  async updateMyProfile(ownerId: string, updateDto: UpdateVendorProfileDto) {
    const vendor = await this.vendorsRepository.findByOwnerId(ownerId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }

    const updated = await this.vendorsRepository.update(vendor.id, {
      name: updateDto.businessName,
      category: updateDto.category,
      description: updateDto.description,
      logo: updateDto.logo,
      coverMedia: updateDto.coverMedia,
      brandStory: updateDto.brandStory,
      logoUrl: updateDto.logoUrl,
      bannerUrl: updateDto.bannerUrl,
      returnPolicy: updateDto.returnPolicy,
      shippingPolicy: updateDto.shippingPolicy,
      vendorType: updateDto.vendorType,
      hasFixedLocation: updateDto.hasFixedLocation,
    });

    const location = await this.vendorsRepository.findVendorLocation(vendor.id);
    return { ...updated, location };
  }

  async updateMyLocation(ownerId: string, locationDto: UpdateVendorLocationDto) {
    const vendor = await this.vendorsRepository.findByOwnerId(ownerId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }

    const now = Date.now();
    const lastUpdate = this.locationUpdateTimestamps.get(vendor.id);

    if (lastUpdate && now - lastUpdate < LOCATION_UPDATE_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil(
        (LOCATION_UPDATE_COOLDOWN_MS - (now - lastUpdate)) / 1000,
      );
      throw new HttpException(
        {
          code: 'LOCATION_RATE_LIMITED',
          message: `Location can only be updated once every 60 seconds. Retry after ${retryAfterSeconds}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.vendorsRepository.updateLocation(vendor.id, locationDto.lat, locationDto.lng);
    this.locationUpdateTimestamps.set(vendor.id, now);
  }

  async getVendorById(id: string) {
    const vendor = await this.vendorsRepository.findById(id);
    if (!vendor || !vendor.verified) {
      throw new NotFoundException('Vendor not found');
    }

    const location = await this.vendorsRepository.findVendorLocation(vendor.id);
    
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ownerId, ...publicVendor } = vendor;
    return { ...publicVendor, location };
  }

  async verifyVendor(id: string) {
    const vendor = await this.vendorsRepository.findById(id);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    return this.vendorsRepository.update(id, { verified: true });
  }

  // --- Product Methods ---

  async getMyProducts(ownerId: string, page: number = 1, limit: number = 10) {
    const vendor = await this.vendorsRepository.findByOwnerId(ownerId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }
    return this.vendorsRepository.findProductsPaginated(vendor.id, page, limit);
  }

  async createProduct(ownerId: string, createDto: CreateProductDto) {
    const vendor = await this.vendorsRepository.findByOwnerId(ownerId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }
    if (!vendor.verified) {
      throw new ForbiddenException('Vendor must be verified to create products');
    }
    
    return this.vendorsRepository.createProduct(vendor.id, {
      title: createDto.title,
      description: createDto.description,
      categoryId: createDto.categoryId,
      basePrice: createDto.basePrice,
      images: createDto.images,
      isActive: createDto.isActive ?? true,
      approvalStatus: 'PENDING',
    });
  }

  async getMyProduct(ownerId: string, productId: string) {
    const vendor = await this.vendorsRepository.findByOwnerId(ownerId);
    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }
    const product = await this.vendorsRepository.findProductByIdAndVendor(productId, vendor.id);
    if (!product) {
      throw new NotFoundException('Product not found or does not belong to you');
    }
    return product;
  }

  async updateProduct(ownerId: string, productId: string, updateDto: UpdateProductDto) {
    // getMyProduct ensures it exists and belongs to the vendor
    await this.getMyProduct(ownerId, productId);
    
    return this.vendorsRepository.updateProduct(productId, {
      ...updateDto,
      approvalStatus: 'PENDING',
      rejectionReason: null,
    });
  }

  async deleteProduct(ownerId: string, productId: string) {
    await this.getMyProduct(ownerId, productId);
    return this.vendorsRepository.softDeleteProduct(productId);
  }

  // --- Product Variant Methods ---

  async createProductVariant(ownerId: string, productId: string, createVariantDto: CreateProductVariantDto) {
    await this.getMyProduct(ownerId, productId);
    try {
      return await this.vendorsRepository.createProductVariant(productId, createVariantDto);
    } catch (error: any) {
      if (error.code === 'P2002' && error.meta?.target?.includes('sku')) {
        throw new ConflictException('SKU must be unique');
      }
      throw error;
    }
  }

  async updateProductVariant(ownerId: string, productId: string, variantId: string, updateVariantDto: UpdateProductVariantDto) {
    const product = await this.getMyProduct(ownerId, productId);
    const variantExists = product.variants.some(v => v.id === variantId);
    if (!variantExists) {
      throw new NotFoundException('Variant not found');
    }
    try {
      return await this.vendorsRepository.updateProductVariant(variantId, updateVariantDto);
    } catch (error: any) {
      if (error.code === 'P2002' && error.meta?.target?.includes('sku')) {
        throw new ConflictException('SKU must be unique');
      }
      throw error;
    }
  }

  async deleteProductVariant(ownerId: string, productId: string, variantId: string) {
    const product = await this.getMyProduct(ownerId, productId);
    const variantExists = product.variants.some(v => v.id === variantId);
    if (!variantExists) {
      throw new NotFoundException('Variant not found');
    }
    return this.vendorsRepository.deleteProductVariant(variantId);
  }
}
