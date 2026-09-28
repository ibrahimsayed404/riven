import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';

// specs/admin-module-spec2.md A7. Writes are audited (CATEGORY_CREATED / CATEGORY_UPDATED).
// Delete is Open Item B3: Product.categoryId is RESTRICT and categories have no deletedAt.
@Controller('admin/categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /** Flat, unpaginated (the taxonomy is small), with product and child counts. */
  @Get()
  listCategories() {
    return this.categoriesService.listForAdmin();
  }

  @Post()
  createCategory(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.createCategory(admin.id, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  updateCategory(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.updateCategory(admin.id, id, dto);
  }

  /** Only when unused: 409 CATEGORY_IN_USE otherwise (specs/admin-module-spec3.md B3b). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.categoriesService.deleteCategory(admin.id, id);
  }
}
