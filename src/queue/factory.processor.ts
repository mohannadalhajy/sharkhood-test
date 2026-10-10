import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { Env } from '../config/env.schema';
import { BatchJob } from '../core/pipeline/batch-job';
import { RunRepository } from '../core/ports/run.repository';
import { RUN_REPOSITORY } from '../core/ports/tokens';
import { BatchService } from './batch.service';
import { DispatcherService } from './dispatcher.service';
import {
  BATCH_JOB,
  DISPATCH_JOB,
  DispatchJobData,
  FACTORY_DLQ,
  FACTORY_QUEUE,
} from './queue.constants';

// Thin: routes jobs to services, and handles final failures.
@Processor(FACTORY_QUEUE)
export class FactoryProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FactoryProcessor.name);

  constructor(
    private readonly dispatcher: DispatcherService,
    private readonly batches: BatchService,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @InjectQueue(FACTORY_DLQ) private readonly dlq: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  // @Processor options are static; the worker exists after onModuleInit.
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.get('WORKER_CONCURRENCY', {
      infer: true,
    });
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case DISPATCH_JOB:
        return this.dispatcher.dispatch((job.data as DispatchJobData).runId);
      case BATCH_JOB:
        return this.batches.process(job.data as BatchJob, job.id);
      default:
        throw new UnrecoverableError(`Unknown job name "${job.name}"`);
    }
  }

  // Fires on every failed attempt. The job's state tells whether BullMQ
  // will retry it ('delayed'/'waiting') or has given up ('failed', also the
  // case for UnrecoverableError). An event handler must not throw: log instead.
  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error): Promise<void> {
    const context = {
      runId: job.data.runId,
      jobId: job.id,
      collection: job.data.collection,
    };
    try {
      if ((await job.getState()) !== 'failed') {
        this.logger.warn({
          message: `attempt ${job.attemptsMade} failed, will retry`,
          ...context,
          error: error.message,
        });
        return;
      }

      this.logger.error({
        message: 'job failed permanently',
        ...context,
        error: error.message,
      });
      await this.dlq.add(
        job.name,
        {
          ...job.data,
          failedReason: error.message,
          attemptsMade: job.attemptsMade,
        },
        { jobId: job.id },
      );
      if (job.name === BATCH_JOB) {
        await this.runs.completeJob(job.data.runId, job.id, 'failed', {
          errors: [
            {
              collection: job.data.collection,
              jobId: job.id,
              reason: error.message,
            },
          ],
        });
      } else {
        await this.runs.setStatus(
          job.data.runId,
          'failed',
          `dispatch failed: ${error.message}`,
        );
      }
    } catch (handlerError) {
      this.logger.error({
        message: 'could not record failed job (DLQ / run update)',
        ...context,
        error: error.message,
        handlerError:
          handlerError instanceof Error
            ? handlerError.message
            : String(handlerError),
      });
    }
  }
}
