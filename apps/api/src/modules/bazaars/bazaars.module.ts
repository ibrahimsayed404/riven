import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { OrganizersRepository } from './organizers.repository';
import { BazaarsRepository } from './bazaars.repository';
import { OrganizersService } from './organizers.service';
import { BazaarsService } from './bazaars.service';
import { BazaarAutocompleteProcessor } from './jobs/bazaar-autocomplete.processor';
import { BazaarJobsService } from './jobs/bazaar-jobs.service';
import { VendorsModule } from '../vendors/vendors.module';
import { AuditModule } from '../audit/audit.module';
import { VendorBazaarApplicationsController } from './vendor-bazaar-applications.controller';
import { PublicBazaarsController } from './public-bazaars.controller';
import { OrganizerBazaarsController } from './organizer-bazaars.controller';
import { AdminOrganizersController } from './admin-organizers.controller';
import { AdminBazaarsController } from './admin-bazaars.controller';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'bazaars',
    }),
    VendorsModule,
    AuditModule,
  ],
  controllers: [
    AdminBazaarsController,
    AdminOrganizersController,
    OrganizerBazaarsController,
    PublicBazaarsController,
    VendorBazaarApplicationsController,
  ],
  providers: [
    OrganizersRepository,
    BazaarsRepository,
    OrganizersService,
    BazaarsService,
    BazaarAutocompleteProcessor,
    BazaarJobsService,
  ],
  exports: [OrganizersService, BazaarsService],
})
export class BazaarsModule {}
