import { Connection, mongo } from 'mongoose';
import { EntityUpsert } from '../core/ports/target-writer';
import { MongoTargetWriter } from './mongo-target-writer';

// A MongoBulkWriteError without a server (instanceof still holds).
function bulkWriteError(writeErrors: unknown): mongo.MongoBulkWriteError {
  return Object.assign(Object.create(mongo.MongoBulkWriteError.prototype), {
    message: 'bulk write failed',
    writeErrors,
    result: { upsertedCount: 0, modifiedCount: 0, matchedCount: 0 },
  });
}

const upsert: EntityUpsert = {
  entity: 'area',
  key: { provider: 'xbyte', platform: 'talabat', externalId: 1468 },
  set: { name: 'Al Zaab' },
  source: {
    provider: 'xbyte',
    platform: 'talabat',
    rawId: '6aa77f2d2ba6464eb6cb3f4c',
    fetchedAt: new Date('2026-09-14T04:59:25.739Z'),
  },
};

function writerWith(bulkWrite: jest.Mock): MongoTargetWriter {
  const connection = { db: { collection: () => ({ bulkWrite }) } };
  return new MongoTargetWriter(connection as unknown as Connection);
}

describe('MongoTargetWriter error handling', () => {
  it('rethrows a bulk write error with empty writeErrors (infrastructure, not duplicates)', async () => {
    const error = bulkWriteError([]);
    const bulkWrite = jest.fn().mockRejectedValue(error);

    await expect(writerWith(bulkWrite).upsertMany([upsert])).rejects.toBe(
      error,
    );
    expect(bulkWrite).toHaveBeenCalledTimes(1); // no duplicate-key retry
  });

  it('rethrows when a non-duplicate error is mixed in', async () => {
    const error = bulkWriteError([
      { code: 11000, index: 0 },
      { code: 121, index: 1 },
    ]);
    await expect(
      writerWith(jest.fn().mockRejectedValue(error)).upsertMany([upsert]),
    ).rejects.toBe(error);
  });

  it('retries E11000 once, then counts the op as unchanged', async () => {
    const duplicate = () => bulkWriteError([{ code: 11000, index: 0 }]);
    const bulkWrite = jest
      .fn()
      .mockRejectedValueOnce(duplicate())
      .mockRejectedValueOnce(duplicate());

    await expect(writerWith(bulkWrite).upsertMany([upsert])).resolves.toEqual({
      upserted: 0,
      modified: 0,
      unchanged: 1,
    });
    expect(bulkWrite).toHaveBeenCalledTimes(2);
  });
});
