import { Injectable, Logger } from '@nestjs/common';

import { PageMeta, pageMeta } from '../../common/dto/pagination-query.dto';

import { AuditLogEntry, AuditLogFilter, AuditLogRow, AuditRepository } from './audit.repository';

export interface AuditLogPage {
  data: AuditLogRow[];
  meta: PageMeta;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly auditRepository: AuditRepository) {}

  /**
   * Best-effort, never rejects. The audit row is written after the domain
   * write has already committed, so a failure here must not surface as a
   * failed moderation action. The full entry is logged so the row can be
   * reconstructed by hand. See specs/admin-module-spec.md §5.2.
   */
  async record(entry: AuditLogEntry): Promise<void> {
    try {
      await this.auditRepository.create(entry);
    } catch (error) {
      this.logger.error(
        `Audit write failed: ${JSON.stringify(entry)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(filter: AuditLogFilter, page: number, limit: number): Promise<AuditLogPage> {
    const { data, total } = await this.auditRepository.findManyPaginated(filter, page, limit);
    return {
      data,
      meta: pageMeta(total, page, limit),
    };
  }
}
