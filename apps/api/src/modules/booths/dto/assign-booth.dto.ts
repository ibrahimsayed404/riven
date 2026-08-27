import { IsString } from 'class-validator';

export class AssignBoothDto {
  @IsString()
  boothListingId: string;
}
