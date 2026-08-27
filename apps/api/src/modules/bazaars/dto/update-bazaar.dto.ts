import { PartialType } from '@nestjs/mapped-types';
import { CreateBazaarDto } from './create-bazaar.dto';

export class UpdateBazaarDto extends PartialType(CreateBazaarDto) {}
