import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminListRatingsQueryDto } from './dto/admin-list-ratings-query.dto';
import { SocialService } from './social.service';

// specs/admin-module-spec2.md A6. Read-only moderation queue: deleting a rating
// or clearing its comment is Open Item B3 (Rating has no deletedAt, so a delete
// would be hard and would change every summary it counted towards).
@Controller('admin/ratings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminRatingsController {
  constructor(private readonly socialService: SocialService) {}

  /** Every rating, newest first. `?hasComment=true&maxScore=2` is the "needs a look" view. */
  @Get()
  listRatings(@Query() query: AdminListRatingsQueryDto) {
    return this.socialService.listRatingsForAdmin({
      targetType: query.targetType,
      targetId: query.targetId,
      userId: query.userId,
      hasComment: query.hasComment,
      maxScore: query.maxScore,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }
}
