import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CreateFavoriteDto,
  CreateFollowDto,
  CreateRatingDto,
  DeleteFavoriteDto,
  DeleteFollowDto,
  GetFavoritesQueryDto,
  GetFollowsQueryDto,
  GetRatingSummaryQueryDto,
  GetRatingsQueryDto,
} from './dto';
import { SocialService } from './social.service';

@Controller('social')
export class SocialController {
  constructor(private readonly socialService: SocialService) {}

  // ---------------------------------------------------------------------------
  // Favorites
  // ---------------------------------------------------------------------------

  @Post('favorites')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SHOPPER)
  addFavorite(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFavoriteDto,
  ) {
    return this.socialService.addFavorite(userId, dto);
  }

  @Delete('favorites')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SHOPPER)
  removeFavorite(
    @CurrentUser('id') userId: string,
    @Body() dto: DeleteFavoriteDto,
  ) {
    return this.socialService.removeFavorite(userId, dto);
  }

  @Get('favorites')
  @UseGuards(JwtAuthGuard)
  getFavorites(
    @CurrentUser('id') userId: string,
    @Query() query: GetFavoritesQueryDto,
  ) {
    return this.socialService.getFavorites(userId, query);
  }

  // ---------------------------------------------------------------------------
  // Follows
  // ---------------------------------------------------------------------------

  @Post('follows')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SHOPPER)
  addFollow(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFollowDto,
  ) {
    return this.socialService.addFollow(userId, dto);
  }

  @Delete('follows')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SHOPPER)
  removeFollow(
    @CurrentUser('id') userId: string,
    @Body() dto: DeleteFollowDto,
  ) {
    return this.socialService.removeFollow(userId, dto);
  }

  @Get('follows')
  @UseGuards(JwtAuthGuard)
  getFollows(
    @CurrentUser('id') userId: string,
    @Query() query: GetFollowsQueryDto,
  ) {
    return this.socialService.getFollows(userId, query);
  }

  // ---------------------------------------------------------------------------
  // Ratings
  // ---------------------------------------------------------------------------

  @Post('ratings')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SHOPPER)
  addRating(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRatingDto,
  ) {
    return this.socialService.addRating(userId, dto);
  }

  @Get('ratings/summary')
  getRatingSummary(@Query() query: GetRatingSummaryQueryDto) {
    return this.socialService.getRatingSummary(query);
  }

  @Get('ratings')
  getRatings(@Query() query: GetRatingsQueryDto) {
    return this.socialService.getRatings(query);
  }
}
