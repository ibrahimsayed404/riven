import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { MediaService } from './media.service';

@Controller('media')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.VENDOR, Role.ORGANIZER)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // Nothing is created server-side — the response is a capability, not a
  // resource — so 200 rather than the POST default of 201.
  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  createUploadUrl(@CurrentUser('id') userId: string, @Body() dto: CreateUploadUrlDto) {
    return this.mediaService.createUploadUrl(userId, dto.purpose, dto.contentType);
  }
}
