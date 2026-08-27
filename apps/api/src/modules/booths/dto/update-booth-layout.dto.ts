import { ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GridConfigDto } from './create-booth-layout.dto';

export class UpdateBoothLayoutDto {
  @ValidateNested()
  @Type(() => GridConfigDto)
  gridConfig: GridConfigDto;
}
