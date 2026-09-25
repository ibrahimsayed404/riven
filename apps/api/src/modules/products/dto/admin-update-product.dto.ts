import { PartialType, PickType } from '@nestjs/mapped-types';

import { CreateProductDto } from '../../vendors/dto/create-product.dto';

/**
 * Admin edit of a product (specs/admin-module-spec3.md B2): title, description and
 * images only, with the vendor DTO's validators. Price, category, isActive and
 * approval state stay out — the whitelist pipe rejects them.
 */
export class AdminUpdateProductDto extends PartialType(
  PickType(CreateProductDto, ['title', 'description', 'images'] as const),
) {}
