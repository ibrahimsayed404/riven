import { IsUUID } from 'class-validator';

export class AssignBoothDto {
  @IsUUID()
  boothListingId: string;
}
