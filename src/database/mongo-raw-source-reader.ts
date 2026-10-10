import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import {
  RawDocument,
  RawSourceReader,
  ReadOptions,
} from '../core/ports/raw-source-reader';
import { RAW_CONNECTION } from './database.constants';

// Read-only: only find() is ever issued against the raw connection.
@Injectable()
export class MongoRawSourceReader implements RawSourceReader {
  constructor(
    @InjectConnection(RAW_CONNECTION) private readonly connection: Connection,
  ) {}

  async *read(
    collection: string,
    options: ReadOptions,
  ): AsyncIterable<RawDocument[]> {
    for await (const docs of this.batches(collection, options, {})) {
      yield docs.map((doc) => ({ id: doc._id.toHexString(), body: doc }));
    }
  }

  async *readIds(
    collection: string,
    options: ReadOptions,
  ): AsyncIterable<string[]> {
    for await (const docs of this.batches(collection, options, { _id: 1 })) {
      yield docs.map((doc) => doc._id.toHexString());
    }
  }

  private async *batches(
    collection: string,
    { batchSize, afterId, untilId }: ReadOptions,
    projection: mongo.Document,
  ): AsyncIterable<mongo.WithId<mongo.Document>[]> {
    const range: mongo.Document = {};
    if (afterId) range.$gt = new mongo.ObjectId(afterId);
    if (untilId) range.$lte = new mongo.ObjectId(untilId);
    const filter = Object.keys(range).length > 0 ? { _id: range } : {};

    const cursor = this.connection.db
      .collection(collection)
      .find(filter, { projection })
      .sort({ _id: 1 })
      .batchSize(batchSize);

    let batch: mongo.WithId<mongo.Document>[] = [];
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length === batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }
}
