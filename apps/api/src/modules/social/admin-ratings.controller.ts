import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminListRatingsQueryDto } from './dto/admin-list-ratings-query.dto';
import { SocialService } from './social.service';

// specs/admin-module-spec2.md A6 (moderation queue) + spec3 B3c (two writes):
// delete removes a fake rating entirely; clear-comment removes abusive text and
// keeps the score. Rating has no deletedAt, so delete is a hard delete.
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRating(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.socialService.deleteRatingForAdmin(admin.id, id);
  }

  @Patch(':id/clear-comment')
  clearComment(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.socialService.clearRatingCommentForAdmin(admin.id, id);
  }
}
