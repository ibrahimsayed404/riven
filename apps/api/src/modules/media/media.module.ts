import { Module } from '@nestjs/common';

import { StorageModule } from '../../infra/storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [StorageModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
