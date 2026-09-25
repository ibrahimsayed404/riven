import { PickType } from '@nestjs/mapped-types';

import { UpdateVendorProfileDto } from './update-vendor-profile.dto';

/**
 * Admin edit of a vendor (specs/admin-module-spec3.md B2): text and image fields
 * only, with the owner DTO's validators. Classification (category, vendorType,
 * hasFixedLocation) and moderation state stay out — the whitelist pipe rejects them.
 */
export class AdminUpdateVendorDto extends PickType(UpdateVendorProfileDto, [
  'businessName',
  'description',
  'brandStory',
  'returnPolicy',
  'shippingPolicy',
  'logo',
  'logoUrl',
  'bannerUrl',
  'coverMedia',
] as const) {}
