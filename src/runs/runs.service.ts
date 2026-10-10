import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  Page,
  QuarantineRecord,
  QuarantineRepository,
} from '../core/ports/quarantine.repository';
import { Run, RunRepository } from '../core/ports/run.repository';
import { QUARANTINE_REPOSITORY, RUN_REPOSITORY } from '../core/ports/tokens';
import {
  DISPATCH_JOB,
  DispatchJobData,
  dispatchJobId,
  FACTORY_QUEUE,
} from '../queue/queue.constants';

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @InjectQueue(FACTORY_QUEUE) private readonly queue: Queue,
  ) {}

  // Dispatching is itself a job: the request returns at once, and a crashed
  // dispatch is retried and resumes from its saved cursor.
  async start(provider: string): Promise<{ runId: string }> {
    const run = await this.runs.create(provider);
    const data: DispatchJobData = { runId: run.id };
    await this.queue.add(DISPATCH_JOB, data, { jobId: dispatchJobId(run.id) });
    this.logger.log({ message: 'run created', runId: run.id, provider });
    return { runId: run.id };
  }

  findRun(id: string): Promise<Run | null> {
    return this.runs.findById(id);
  }

  findErrors(
    runId: string,
    page: { offset: number; limit: number },
  ): Promise<Page<QuarantineRecord>> {
    return this.quarantine.findByRun(runId, page);
  }
}
