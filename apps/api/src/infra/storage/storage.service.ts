import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const UPLOAD_URL_TTL_SECONDS = 300;

export type UploadTarget = {
  /** Presigned PUT. The client sends the bytes here with the same Content-Type. */
  uploadUrl: string;
  /** Where the object is readable once uploaded — this is what gets stored on the entity. */
  publicUrl: string;
  key: string;
  expiresInSeconds: number;
};

// Thin wrapper over the S3 SDK so modules never touch the client directly.
// forcePathStyle is required by MinIO and harmless for R2/S3.
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('S3_BUCKET');
    this.publicUrl = configService.getOrThrow<string>('S3_PUBLIC_URL').replace(/\/+$/, '');
    this.client = new S3Client({
      endpoint: configService.getOrThrow<string>('S3_ENDPOINT'),
      region: configService.getOrThrow<string>('S3_REGION'),
      forcePathStyle: true,
      // Without this the SDK bakes a CRC32 of an *empty* body into every
      // presigned PUT, and the real upload fails the checksum on S3/R2.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: configService.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
    });
  }

  async createUploadUrl(key: string, contentType: string): Promise<UploadTarget> {
    // Content-Type is explicitly signed (the SDK only signs host by default),
    // so a PUT that lies about its type fails the signature check at the store
    // and the allowlist enforced upstream actually holds.
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-type']),
    });

    return {
      uploadUrl,
      publicUrl: `${this.publicUrl}/${key}`,
      key,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }
}
