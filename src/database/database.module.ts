import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Env } from '../config/env.schema';
import { RAW_SOURCE_READER } from '../core/ports/tokens';
import { RAW_CONNECTION, TARGET_CONNECTION } from './database.constants';
import { MongoRawSourceReader } from './mongo-raw-source-reader';

@Module({
  imports: [
    // Raw is read-only: never let Mongoose create collections or indexes there.
    MongooseModule.forRootAsync({
      connectionName: RAW_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGO_RAW_URI', { infer: true }),
        autoIndex: false,
        autoCreate: false,
      }),
    }),
    MongooseModule.forRootAsync({
      connectionName: TARGET_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGO_TARGET_URI', { infer: true }),
      }),
    }),
  ],
  providers: [{ provide: RAW_SOURCE_READER, useClass: MongoRawSourceReader }],
  exports: [RAW_SOURCE_READER],
})
export class DatabaseModule {}
