import { JobSchedulerJson, JobSchedulerTemplateOptions, Queue } from 'bullmq';

/** PROCESS_ROLE: "api" leaves scheduled background work to a separate worker (specs/commerce/22 §5.4). */
export type ProcessRole = 'all' | 'api' | 'worker';

export function ownsScheduledJobs(role: ProcessRole | undefined): boolean {
  return role !== 'api';
}

export interface SchedulerSpec {
  id: string;
  pattern: string;
  intervalMs: number;
  jobName: string;
  templateOptions: JobSchedulerTemplateOptions;
}

/** Present, on the expected pattern, and its next job not more than one interval overdue (21 §8.2.1). */
export function isSchedulerHealthy(scheduler: JobSchedulerJson | undefined, spec: SchedulerSpec, now: number): boolean {
  return !!scheduler && scheduler.pattern === spec.pattern && typeof scheduler.next === 'number' && scheduler.next >= now - spec.intervalMs;
}

/**
 * Idempotent schedule reconciliation: upserts the scheduler under its fixed id
 * when it is missing, on the wrong pattern, or has lost its next job. Any number
 * of instances can run it at once and converge on one schedule.
 */
export async function reconcileJobScheduler(queue: Queue, spec: SchedulerSpec): Promise<{ outcome: 'healthy' | 'recreated'; reason?: string }> {
  const scheduler = await queue.getJobScheduler(spec.id);
  if (isSchedulerHealthy(scheduler, spec, Date.now())) return { outcome: 'healthy' };
  const reason = !scheduler ? 'missing' : scheduler.pattern !== spec.pattern ? `pattern ${scheduler.pattern ?? 'none'}` : 'next run overdue';
  await queue.upsertJobScheduler(spec.id, { pattern: spec.pattern }, { name: spec.jobName, data: {}, opts: spec.templateOptions });
  return { outcome: 'recreated', reason };
}
