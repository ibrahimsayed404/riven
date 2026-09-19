import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

import { VendorsService } from './vendors.service';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { UpdateVendorLocationDto } from './dto/update-vendor-location.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateProductVariantDto } from './dto/create-product-variant.dto';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto';

@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.vendorsService.getMyProfile(user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  updateMyProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateDto: UpdateVendorProfileDto,
  ) {
    return this.vendorsService.updateMyProfile(user.id, updateDto);
  }

  // Once a minute per vendor (UserThrottlerGuard keys by user id) — fix.js ROBUST-01.
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  @Patch('me/location')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  updateMyLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() locationDto: UpdateVendorLocationDto,
  ) {
    return this.vendorsService.updateMyLocation(user.id, locationDto);
  }

  @Get(':id')
  getVendorById(@Param('id') id: string) {
    return this.vendorsService.getVendorById(id);
  }

  // --- Product Endpoints ---

  @Get('me/products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  getMyProducts(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.vendorsService.getMyProducts(user.id, query.page ?? 1, query.limit ?? 20);
  }

  @Post('me/products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  createProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createDto: CreateProductDto,
  ) {
    return this.vendorsService.createProduct(user.id, createDto);
  }

  @Get('me/products/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  getMyProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
  ) {
    return this.vendorsService.getMyProduct(user.id, productId);
  }

  @Patch('me/products/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  updateProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() updateDto: UpdateProductDto,
  ) {
    return this.vendorsService.updateProduct(user.id, productId, updateDto);
  }

  @Delete('me/products/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  deleteProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
  ) {
    return this.vendorsService.deleteProduct(user.id, productId);
  }

  // --- Product Variant Endpoints ---

  @Post('me/products/:id/variants')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  createProductVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() createVariantDto: CreateProductVariantDto,
  ) {
    return this.vendorsService.createProductVariant(user.id, productId, createVariantDto);
  }

  @Patch('me/products/:id/variants/:variantId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  updateProductVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Param('variantId') variantId: string,
    @Body() updateVariantDto: UpdateProductVariantDto,
  ) {
    return this.vendorsService.updateProductVariant(user.id, productId, variantId, updateVariantDto);
  }

  @Delete('me/products/:id/variants/:variantId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.VENDOR)
  deleteProductVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Param('variantId') variantId: string,
  ) {
    return this.vendorsService.deleteProductVariant(user.id, productId, variantId);
  }
}
