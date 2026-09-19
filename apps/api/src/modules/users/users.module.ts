import { Module } from '@nestjs/common';

import { AdminUsersController } from './admin-users.controller';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BazaarsModule } from '../bazaars/bazaars.module';
import { VendorsModule } from '../vendors/vendors.module';

@Module({
  imports: [AuditModule, AuthModule, VendorsModule, BazaarsModule],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
