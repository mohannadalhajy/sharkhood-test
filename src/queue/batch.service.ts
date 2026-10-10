import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { BatchJob } from '../core/pipeline/batch-job';
import { runBatch } from '../core/pipeline/runner';
import { QuarantineRepository } from '../core/ports/quarantine.repository';
import { RawDocument, RawSourceReader } from '../core/ports/raw-source-reader';
import { RunRepository } from '../core/ports/run.repository';
import { TargetWriter } from '../core/ports/target-writer';
import {
  QUARANTINE_REPOSITORY,
  RAW_SOURCE_READER,
  RUN_REPOSITORY,
  TARGET_WRITER,
} from '../core/ports/tokens';
import { ProviderRegistry } from '../providers/provider-registry';

// One job = one fixed _id range. Bad documents never throw: they come back
// from the pipeline as failures and are quarantined. Anything that throws
// here is infrastructure (Mongo down, ...) and is retried by BullMQ.
@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);

  constructor(
    @Inject(RAW_SOURCE_READER) private readonly reader: RawSourceReader,
    @Inject(TARGET_WRITER) private readonly writer: TargetWriter,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly providers: ProviderRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async process(job: BatchJob, jobId: string): Promise<void> {
    const { runId, collection } = job;
    const adapter = this.providers.get(job.provider);
    const source = this.providers.source(job.provider, collection);

    // The range holds at most BATCH_SIZE docs (cut by the dispatcher).
    const docs: RawDocument[] = [];
    for await (const batch of this.reader.read(collection, {
      batchSize: this.config.get('BATCH_SIZE', { infer: true }),
      afterId: job.afterId,
      untilId: job.untilId,
    })) {
      docs.push(...batch);
    }

    const result = runBatch(adapter, source, docs);
    const written = await this.writer.upsertMany(result.upserts);
    await this.quarantine.addMany(
      result.failures.map((f) => ({ ...f, runId, jobId, collection })),
    );

    const counters = {
      read: docs.length,
      transformed: result.upserts.length,
      written: written.upserted + written.modified,
      skipped: written.unchanged,
      failed: result.failures.length,
    };
    await this.runs.completeJob(runId, jobId, 'done', {
      counters,
      stages: result.counters,
    });
    this.logger.log({
      message: 'batch processed',
      runId,
      jobId,
      collection,
      ...counters,
    });
  }
}
