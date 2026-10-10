import { mongo } from 'mongoose';

const DUPLICATE_KEY = 11000;

// The write errors of a bulk write that failed ONLY on duplicate keys, or
// null for anything else. An error with no writeErrors (e.g. a write concern
// or network failure surfaced as MongoBulkWriteError) is not "duplicates
// only": callers must rethrow it so the job is retried.
export function duplicateKeyErrorsOnly(
  err: unknown,
): mongo.WriteError[] | null {
  if (!(err instanceof mongo.MongoBulkWriteError)) return null;
  const errors = [err.writeErrors]
    .flat()
    .filter((e) => e !== undefined && e !== null);
  const duplicatesOnly =
    errors.length > 0 && errors.every((e) => e.code === DUPLICATE_KEY);
  return duplicatesOnly ? errors : null;
}
