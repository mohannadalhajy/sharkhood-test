import { mongo } from 'mongoose';
import { duplicateKeyErrorsOnly } from './mongo-errors';

// Builds a MongoBulkWriteError without a server (instanceof still holds).
function bulkWriteError(
  writeErrors: unknown,
  result: Partial<mongo.BulkWriteResult> = {},
): mongo.MongoBulkWriteError {
  return Object.assign(Object.create(mongo.MongoBulkWriteError.prototype), {
    message: 'bulk write failed',
    writeErrors,
    result: { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, ...result },
  });
}

describe('duplicateKeyErrorsOnly', () => {
  it('returns the errors when every write error is E11000', () => {
    const errors = [
      { code: 11000, index: 0 },
      { code: 11000, index: 2 },
    ];
    expect(duplicateKeyErrorsOnly(bulkWriteError(errors))).toEqual(errors);
  });

  it('accepts a single (non-array) write error', () => {
    const error = { code: 11000, index: 0 };
    expect(duplicateKeyErrorsOnly(bulkWriteError(error))).toEqual([error]);
  });

  it.each([
    ['empty writeErrors', []],
    ['missing writeErrors', undefined],
    [
      'a non-duplicate error among duplicates',
      [{ code: 11000 }, { code: 121 }],
    ],
  ])('returns null for %s', (_label, writeErrors) => {
    expect(duplicateKeyErrorsOnly(bulkWriteError(writeErrors))).toBeNull();
  });

  it('returns null for errors that are not bulk write errors', () => {
    expect(duplicateKeyErrorsOnly(new Error('connection reset'))).toBeNull();
  });
});
