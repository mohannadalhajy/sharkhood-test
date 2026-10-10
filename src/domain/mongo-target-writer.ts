import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import {
  EntityUpsert,
  TargetWriter,
  WriteSummary,
} from '../core/ports/target-writer';
import { TARGET_CONNECTION } from '../database/database.constants';
import { duplicateKeyErrorsOnly } from '../database/mongo-errors';
import { ENTITY_COLLECTIONS, TARGET_INDEXES } from './target-collections';

type Op = mongo.AnyBulkWriteOperation<mongo.Document>;

// Implements the TargetWriter contract (see core/ports/target-writer.ts).
@Injectable()
export class MongoTargetWriter implements TargetWriter, OnModuleInit {
  constructor(
    @InjectConnection(TARGET_CONNECTION)
    private readonly connection: Connection,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const { collection, key, options } of TARGET_INDEXES) {
      await this.connection.db.collection(collection).createIndex(key, options);
    }
  }

  async upsertMany(upserts: EntityUpsert[]): Promise<WriteSummary> {
    const total: WriteSummary = { upserted: 0, modified: 0, unchanged: 0 };
    for (const [name, group] of groupByCollection(upserts)) {
      const collection = this.connection.db.collection(name);
      // 1. Unconditional set unions first; their counts are not reported
      //    (one entity = one guarded write below).
      const addToSetOps = group.filter((u) => u.addToSet).map(addToSetOp);
      if (addToSetOps.length > 0)
        await bulkWriteWithRetry(collection, addToSetOps);
      // 2. Guarded owned fields.
      const result = await bulkWriteWithRetry(
        collection,
        group.map(guardedSetOp),
      );
      total.upserted += result.upserted;
      total.modified += result.modified;
      total.unchanged += result.unchanged;
    }
    return total;
  }
}

function groupByCollection(
  upserts: EntityUpsert[],
): Map<string, EntityUpsert[]> {
  const groups = new Map<string, EntityUpsert[]>();
  for (const upsert of upserts) {
    const name = ENTITY_COLLECTIONS[upsert.entity];
    if (!name)
      throw new Error(`No target collection for entity "${upsert.entity}"`);
    const group = groups.get(name);
    if (group) group.push(upsert);
    else groups.set(name, [upsert]);
  }
  return groups;
}

function addToSetOp(upsert: EntityUpsert): Op {
  const $addToSet = Object.fromEntries(
    Object.entries(upsert.addToSet).map(([field, values]) => [
      field,
      { $each: values },
    ]),
  );
  return {
    updateOne: { filter: upsert.key, update: { $addToSet }, upsert: true },
  };
}

// Filter: natural key AND (source record missing OR older OR same time with
// a smaller rawId). Update pipeline: owned fields + source record, then
// derived fields via $ifNull over the stored state.
function guardedSetOp({ key, set, derived, source }: EntityUpsert): Op {
  const record = source.slot ? `sources.${source.slot}` : 'source';
  const { rawId, fetchedAt } = source;

  const fields: Record<string, unknown> = {
    ...set,
    [`${record}.rawId`]: rawId,
    [`${record}.fetchedAt`]: fetchedAt,
  };
  if (!source.slot) {
    fields['source.provider'] = source.provider;
    fields['source.platform'] = source.platform;
  }

  const pipeline: mongo.Document[] = [
    // $literal: a string value like "$5 deal" must not be read as a path.
    { $set: mapValues(fields, (value) => ({ $literal: value })) },
  ];
  if (derived) {
    pipeline.push({
      $set: mapValues(derived, (paths) => ({
        $ifNull: [...paths.map((p) => `$${p}`), null],
      })),
    });
  }

  return {
    updateOne: {
      filter: {
        ...key,
        $or: [
          { [record]: { $exists: false } },
          { [`${record}.fetchedAt`]: { $lt: fetchedAt } },
          {
            [`${record}.fetchedAt`]: fetchedAt,
            [`${record}.rawId`]: { $lt: rawId },
          },
        ],
      },
      update: pipeline,
      upsert: true,
    },
  };
}

// A guarded upsert whose guard does not match an existing doc tries to
// insert and fails with E11000. Retry those ops once (the doc may have been
// inserted concurrently, so the guard can now match); a second E11000
// means the stored source is newer -> unchanged.
async function bulkWriteWithRetry(
  collection: mongo.Collection,
  ops: Op[],
): Promise<WriteSummary> {
  const first = await bulkWrite(collection, ops);
  if (first.duplicates.length === 0) return first.summary;
  const second = await bulkWrite(collection, first.duplicates);
  return {
    upserted: first.summary.upserted + second.summary.upserted,
    modified: first.summary.modified + second.summary.modified,
    unchanged:
      first.summary.unchanged +
      second.summary.unchanged +
      second.duplicates.length,
  };
}

async function bulkWrite(
  collection: mongo.Collection,
  ops: Op[],
): Promise<{ summary: WriteSummary; duplicates: Op[] }> {
  try {
    const result = await collection.bulkWrite(ops, { ordered: false });
    return { summary: summarise(result), duplicates: [] };
  } catch (err) {
    // Anything but "only duplicate keys" is a real failure: let the job retry.
    const duplicates = duplicateKeyErrorsOnly(err);
    if (!duplicates) throw err;
    return {
      summary: summarise((err as mongo.MongoBulkWriteError).result),
      duplicates: duplicates.map((e) => ops[e.index]),
    };
  }
}

function summarise(result: mongo.BulkWriteResult): WriteSummary {
  return {
    upserted: result.upsertedCount,
    modified: result.modifiedCount,
    unchanged: result.matchedCount - result.modifiedCount,
  };
}

function mapValues<T>(
  obj: Record<string, T>,
  fn: (value: T) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
