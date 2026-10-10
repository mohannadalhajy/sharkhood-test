import { Module } from '@nestjs/common';
import { QUARANTINE_REPOSITORY, RUN_REPOSITORY } from '../core/ports/tokens';
import { ProvidersModule } from '../providers/providers.module';
import { QueueModule } from '../queue/queue.module';
import { MongoQuarantineRepository } from './mongo-quarantine.repository';
import { MongoRunRepository } from './mongo-run.repository';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [QueueModule, ProvidersModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    { provide: RUN_REPOSITORY, useClass: MongoRunRepository },
    { provide: QUARANTINE_REPOSITORY, useClass: MongoQuarantineRepository },
  ],
  exports: [RUN_REPOSITORY, QUARANTINE_REPOSITORY],
})
export class RunsModule {}
