import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { WorkerModule } from './queue/worker.module';
import { RunsModule } from './runs/runs.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    QueueModule,
    HealthModule,
    RunsModule,
    WorkerModule,
  ],
})
export class AppModule {}
