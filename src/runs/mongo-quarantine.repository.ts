import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import {
  Page,
  QuarantineEntry,
  QuarantineRecord,
  QuarantineRepository,
} from '../core/ports/quarantine.repository';
import { TARGET_CONNECTION } from '../database/database.constants';
import { duplicateKeyErrorsOnly } from '../database/mongo-errors';

@Injectable()
export class MongoQuarantineRepository
  implements QuarantineRepository, OnModuleInit
{
  constructor(
    @InjectConnection(TARGET_CONNECTION)
    private readonly connection: Connection,
  ) {}

  private get quarantine(): mongo.Collection {
    return this.connection.db.collection('quarantine');
  }

  async onModuleInit(): Promise<void> {
    // Identity of an entry: makes addMany an idempotent upsert.
    await this.quarantine.createIndex(
      {
        runId: 1,
        collection: 1,
        rawId: 1,
        entity: 1,
        recordIndex: 1,
        stage: 1,
      },
      { unique: true },
    );
    // GET /runs/:id/errors, in insertion order.
    await this.quarantine.createIndex({ runId: 1, createdAt: 1 });
  }

  async addMany(entries: QuarantineEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const ops = entries.map(({ jobId, reason, ...identity }) => ({
      updateOne: {
        filter: {
          ...identity,
          entity: identity.entity ?? null,
          recordIndex: identity.recordIndex ?? null,
        },
        update: {
          $set: { jobId, reason },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    }));
    try {
      await this.quarantine.bulkWrite(ops, { ordered: false });
    } catch (err) {
      // A concurrent upsert of the same entry already inserted it: fine.
      if (!duplicateKeyErrorsOnly(err)) throw err;
    }
  }

  async findByRun(
    runId: string,
    { offset, limit }: { offset: number; limit: number },
  ): Promise<Page<QuarantineRecord>> {
    const [items, total] = await Promise.all([
      this.quarantine
        .find({ runId }, { projection: { _id: 0 } })
        .sort({ createdAt: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      this.quarantine.countDocuments({ runId }),
    ]);
    return { items: items as unknown as QuarantineRecord[], total };
  }
}
