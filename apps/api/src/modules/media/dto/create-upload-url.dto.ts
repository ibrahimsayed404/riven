import { IsEnum, IsIn } from 'class-validator';

export enum UploadPurpose {
  PRODUCT_IMAGE = 'PRODUCT_IMAGE',
  VENDOR_LOGO = 'VENDOR_LOGO',
  VENDOR_COVER = 'VENDOR_COVER',
  BAZAAR_COVER = 'BAZAAR_COVER',
}

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export class CreateUploadUrlDto {
  @IsEnum(UploadPurpose)
  purpose!: UploadPurpose;

  @IsIn(ALLOWED_IMAGE_TYPES)
  contentType!: AllowedImageType;
}
