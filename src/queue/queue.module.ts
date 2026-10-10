import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { FACTORY_DLQ, FACTORY_QUEUE } from './queue.constants';

// Queue registration only (no processors), so the API, health check and
// worker can all enqueue/inspect without a circular import.
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          host: config.get('REDIS_HOST', { infer: true }),
          port: config.get('REDIS_PORT', { infer: true }),
        },
      }),
    }),
    BullModule.registerQueue(
      {
        name: FACTORY_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          // Completed jobs are kept so a re-dispatched jobId is deduplicated.
        },
      },
      // Jobs that exhausted their attempts; kept for inspection, never processed.
      { name: FACTORY_DLQ },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
