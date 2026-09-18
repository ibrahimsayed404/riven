import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { StorageService, UploadTarget } from '../../infra/storage/storage.service';
import { AllowedImageType, UploadPurpose } from './dto/create-upload-url.dto';

const EXTENSION: Record<AllowedImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const PREFIX: Record<UploadPurpose, string> = {
  [UploadPurpose.PRODUCT_IMAGE]: 'product-image',
  [UploadPurpose.VENDOR_LOGO]: 'vendor-logo',
  [UploadPurpose.VENDOR_COVER]: 'vendor-cover',
  [UploadPurpose.BAZAAR_COVER]: 'bazaar-cover',
};

@Injectable()
export class MediaService {
  constructor(private readonly storageService: StorageService) {}

  createUploadUrl(userId: string, purpose: UploadPurpose, contentType: AllowedImageType): Promise<UploadTarget> {
    // Key is namespaced by purpose and uploader and ends in a fresh uuid, so a
    // signed URL can only ever write under the caller's own prefix and never
    // overwrites an existing object.
    const key = `${PREFIX[purpose]}/${userId}/${randomUUID()}.${EXTENSION[contentType]}`;
    return this.storageService.createUploadUrl(key, contentType);
  }
}

export { PREFIX as UPLOAD_KEY_PREFIX };
