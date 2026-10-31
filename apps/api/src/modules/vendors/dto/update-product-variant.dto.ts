import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateProductVariantDto } from './create-product-variant.dto';

/**
 * Everything but stock. Stock is never set to an absolute number after the
 * variant exists (TD-08, specs/commerce/25 S3): an absolute write could erase
 * units a checkout just reserved. Use POST …/stock-adjustments with a signed
 * change instead; sending stockQuantity here is a 400.
 */
export class UpdateProductVariantDto extends PartialType(OmitType(CreateProductVariantDto, ['stockQuantity'] as const)) {}
