import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AdminCategoriesController } from './admin-categories.controller';
import { CategoriesController } from './categories.controller';
import { CategoriesRepository } from './categories.repository';
import { CategoriesService } from './categories.service';

// SearchIndexQueue comes from the global SearchInfraModule; AuditModule is the leaf audit writer.
@Module({
  imports: [AuditModule],
  controllers: [AdminCategoriesController, CategoriesController],
  providers: [CategoriesService, CategoriesRepository],
})
export class CategoriesModule {}
