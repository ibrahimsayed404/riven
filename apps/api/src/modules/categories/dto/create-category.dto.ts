import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

/** Lowercase words joined by single hyphens: `women`, `maxi-dresses`. */
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateCategoryDto {
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsString()
  @MaxLength(60)
  @Matches(CATEGORY_SLUG_PATTERN, { message: 'slug must be lowercase letters/digits joined by single hyphens' })
  slug!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(CATEGORY_SLUG_PATTERN, { message: 'slug must be lowercase letters/digits joined by single hyphens' })
  slug?: string;

  /** A uuid moves the category under that parent; `null` moves it to the root; omitted leaves it. */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
