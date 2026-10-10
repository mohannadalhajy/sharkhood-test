import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DomainModule } from '../domain/domain.module';
import { ProvidersModule } from '../providers/providers.module';
import { RunsModule } from '../runs/runs.module';
import { BatchService } from './batch.service';
import { DispatcherService } from './dispatcher.service';
import { FactoryProcessor } from './factory.processor';
import { QueueModule } from './queue.module';

@Module({
  imports: [
    QueueModule,
    DatabaseModule,
    DomainModule,
    RunsModule,
    ProvidersModule,
  ],
  providers: [DispatcherService, BatchService, FactoryProcessor],
})
export class WorkerModule {}
