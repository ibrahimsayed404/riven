import { IsEnum, IsIn, IsInt, Max, Min } from 'class-validator';

export enum UploadPurpose {
  PRODUCT_IMAGE = 'PRODUCT_IMAGE',
  VENDOR_LOGO = 'VENDOR_LOGO',
  VENDOR_COVER = 'VENDOR_COVER',
  BAZAAR_COVER = 'BAZAAR_COVER',
}

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** 10 MB — the documented upload limit, now enforced by the signed URL itself (commerce/25 §10). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export class CreateUploadUrlDto {
  @IsEnum(UploadPurpose)
  purpose!: UploadPurpose;

  @IsIn(ALLOWED_IMAGE_TYPES)
  contentType!: AllowedImageType;

  /** Exact size of the file in bytes. Signed into the URL: storage refuses a PUT of any other size. */
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  contentLength!: number;
}
