import { PartialType, PickType } from '@nestjs/mapped-types';
import { RegisterOrganizerDto } from '../../auth/dto/register-organizer.dto';

export class UpdateOrganizerProfileDto extends PartialType(
  PickType(RegisterOrganizerDto, ['name'] as const)
) {}
