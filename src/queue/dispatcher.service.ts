import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, UnrecoverableError } from 'bullmq';
import { Env } from '../config/env.schema';
import { BatchJob, batchJobId } from '../core/pipeline/batch-job';
import { RawSourceReader } from '../core/ports/raw-source-reader';
import { RunRepository } from '../core/ports/run.repository';
import { RAW_SOURCE_READER, RUN_REPOSITORY } from '../core/ports/tokens';
import { ProviderRegistry } from '../providers/provider-registry';
import { BATCH_JOB, FACTORY_QUEUE } from './queue.constants';

// Pages each source collection by _id (ids only) and enqueues one job per
// range of BATCH_SIZE documents. Resumable: the cursor is saved after each
// enqueue, and job ids are deterministic, so a retried dispatch re-adds at
// most one job, which BullMQ deduplicates.
@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    @Inject(RAW_SOURCE_READER) private readonly reader: RawSourceReader,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @InjectQueue(FACTORY_QUEUE) private readonly queue: Queue,
    private readonly providers: ProviderRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async dispatch(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run) throw new UnrecoverableError(`Run ${runId} not found`);
    await this.runs.setStatus(runId, 'running');

    const batchSize = this.config.get('BATCH_SIZE', { infer: true });
    const collections = this.providers
      .get(run.provider)
      .sources.map((s) => s.collection);
    const cursor = run.dispatchCursor;

    // Fresh dispatch only: a source with no documents (or a missing
    // collection: Mongo reads it as empty) means a misconfigured raw DB, not
    // a successful run with zero counts. Checked before enqueuing anything.
    if (!cursor) {
      for (const collection of collections) {
        if (!(await this.hasDocuments(collection))) {
          const error = `no source documents found in ${collection}`;
          await this.runs.setStatus(runId, 'failed', error);
          this.logger.error({
            message: 'dispatch aborted',
            runId,
            collection,
            error,
          });
          return;
        }
      }
    }

    const start = cursor ? collections.indexOf(cursor.collection) : 0;
    let batchNo = cursor?.batchNo ?? 0;

    for (let i = start; i < collections.length; i++) {
      const collection = collections[i];
      let afterId = i === start ? cursor?.afterId : undefined;
      for await (const ids of this.reader.readIds(collection, {
        batchSize,
        afterId,
      })) {
        const job: BatchJob = {
          runId,
          provider: run.provider,
          collection,
          batchNo,
          afterId,
          untilId: ids[ids.length - 1],
        };
        await this.queue.add(BATCH_JOB, job, { jobId: batchJobId(job) });
        batchNo++;
        afterId = job.untilId;
        await this.runs.saveDispatchCursor(runId, {
          collection,
          afterId,
          batchNo,
        });
      }
      if (i + 1 < collections.length) {
        await this.runs.saveDispatchCursor(runId, {
          collection: collections[i + 1],
          batchNo,
        });
      }
    }

    await this.runs.setJobsTotal(runId, batchNo);
    this.logger.log({ message: 'dispatch finished', runId, jobs: batchNo });
  }

  private async hasDocuments(collection: string): Promise<boolean> {
    for await (const ids of this.reader.readIds(collection, { batchSize: 1 })) {
      return ids.length > 0;
    }
    return false;
  }
}
