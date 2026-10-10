import { Module } from '@nestjs/common';
import { TARGET_WRITER } from '../core/ports/tokens';
import { MongoTargetWriter } from './mongo-target-writer';

// Target collections: the generic writer plus their index definitions.
@Module({
  providers: [{ provide: TARGET_WRITER, useClass: MongoTargetWriter }],
  exports: [TARGET_WRITER],
})
export class DomainModule {}
