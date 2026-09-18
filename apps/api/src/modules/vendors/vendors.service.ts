import { Injectable, NotFoundException, HttpException, HttpStatus, ForbiddenException, ConflictException } from '@nestjs/common';
import { AdminAction, AdminTargetType, Prisma } from '@prisma/client';

import { VendorsRepository, IdPage, VendorModerationStatus } from './vendors.repository';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { AuditService } from '../audit/audit.service';
import { VendorSearchDocument } from '../../infra/search/search-documents';
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

  constructor(
    private readonly vendorsRepository: VendorsRepository,
    private readonly searchIndexQueue: SearchIndexQueue,
    private readonly auditService: AuditService,
  ) {}

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

    await this.searchIndexQueue.enqueue({ type: 'VENDOR', id: vendor.id });

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
    await this.searchIndexQueue.enqueue({ type: 'VENDOR', id: vendor.id });
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

  // --- Admin moderation (specs/admin-module-spec.md §3, §4.1) ---

  async listForAdmin(params: {
    status?: VendorModerationStatus;
    search?: string;
    page: number;
    limit: number;
  }) {
    const { data, total } = await this.vendorsRepository.findManyForAdmin(params);
    return {
      data,
      meta: {
        total,
        page: params.page,
        limit: params.limit,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  countPendingForAdmin(): Promise<number> {
    return this.vendorsRepository.countPendingForAdmin();
  }

  verifyVendor(adminId: string, id: string) {
    return this.moderateVendor(adminId, id, { verified: true, rejectionReason: null }, AdminAction.VENDOR_VERIFIED);
  }

  /** Works on a pending vendor (reject) and on a verified one (revoke). */
  rejectVendor(adminId: string, id: string, reason: string) {
    return this.moderateVendor(adminId, id, { verified: false, rejectionReason: reason }, AdminAction.VENDOR_REJECTED);
  }

  /**
   * One transition function for verify and reject. Idempotent: when the target
   * state equals the current one nothing is written, audited or enqueued.
   * Audit is recorded after the write, best-effort — see AuditService.record.
   */
  private async moderateVendor(
    adminId: string,
    id: string,
    target: { verified: boolean; rejectionReason: string | null },
    action: AdminAction,
  ) {
    const current = await this.vendorsRepository.findModerationState(id);
    if (!current || current.deletedAt) {
      throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found.' });
    }

    const unchanged =
      current.verified === target.verified && current.rejectionReason === target.rejectionReason;
    if (unchanged) {
      return { id: current.id, verified: current.verified, rejectionReason: current.rejectionReason };
    }

    const updated = await this.vendorsRepository.update(id, target);

    if (current.verified !== target.verified) {
      // Flipping `verified` changes the visibility of every product of this vendor
      // without touching a product row. Exactly two jobs regardless of catalog
      // size: the vendor itself, and a fan-out job that pages the products.
      // A reason-only change leaves visibility alone, so nothing to enqueue.
      await this.searchIndexQueue.enqueueMany([
        { type: 'VENDOR', id },
        { type: 'VENDOR_PRODUCTS', vendorId: id },
      ]);
    }

    await this.auditService.record({
      actorId: adminId,
      action,
      targetType: AdminTargetType.VENDOR,
      targetId: id,
      reason: target.rejectionReason,
    });

    return { id: updated.id, verified: updated.verified, rejectionReason: updated.rejectionReason };
  }

  // --- Search index support (read-only; the single authority on vendor eligibility) ---

  /** The vendor's search document, or null when unverified / soft-deleted. */
  async getSearchDocument(id: string): Promise<VendorSearchDocument | null> {
    const vendor = await this.vendorsRepository.findForSearch(id);
    if (!vendor) return null;

    const location = await this.vendorsRepository.findVendorLocation(id);

    return {
      id: vendor.id,
      name: vendor.name,
      category: vendor.category,
      description: vendor.description,
      brandStory: vendor.brandStory,
      logoUrl: vendor.logoUrl,
      bannerUrl: vendor.bannerUrl,
      vendorType: vendor.vendorType,
      hasFixedLocation: vendor.hasFixedLocation,
      // Omit (not null) when absent so _geoRadius excludes the vendor cleanly.
      ...(location ? { _geo: location } : {}),
    };
  }

  listPublicVendorIds(cursor: string | null, take: number): Promise<IdPage> {
    return this.vendorsRepository.listPublicIds(cursor, take);
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
    
    const product = await this.vendorsRepository.createProduct(vendor.id, {
      title: createDto.title,
      description: createDto.description,
      categoryId: createDto.categoryId,
      basePrice: createDto.basePrice,
      images: createDto.images,
      isActive: createDto.isActive ?? true,
      approvalStatus: 'PENDING',
    });
    // A new product is PENDING, so this resolves to "not eligible" → no-op on the
    // index. Enqueued anyway: eligibility is decided in one place, not here.
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id: product.id });
    return product;
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
    
    const updated = await this.vendorsRepository.updateProduct(productId, {
      ...updateDto,
      approvalStatus: 'PENDING',
      rejectionReason: null,
    });
    // Reset to PENDING means the sync job *removes* it from the index until re-approved.
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id: productId });
    return updated;
  }

  async deleteProduct(ownerId: string, productId: string) {
    await this.getMyProduct(ownerId, productId);
    const deleted = await this.vendorsRepository.softDeleteProduct(productId);
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id: productId });
    return deleted;
  }

  // --- Product Variant Methods ---

  async createProductVariant(ownerId: string, productId: string, createVariantDto: CreateProductVariantDto) {
    await this.getMyProduct(ownerId, productId);
    try {
      const variant = await this.vendorsRepository.createProductVariant(productId, createVariantDto);
      // minPrice/maxPrice/sizes/colors derive from variants → re-index the parent.
      await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id: productId });
      return variant;
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
      const variant = await this.vendorsRepository.updateProductVariant(variantId, updateVariantDto);
      await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id: productId });
      return variant;
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
    const variant = await this.vendorsRepository.deleteProductVariant(variantId);
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id: productId });
    return variant;
  }
}
