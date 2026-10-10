// A worker job owns a fixed _id range of one collection, so a retried or
// restarted job reprocesses exactly the same documents.
export interface BatchJob {
  runId: string;
  provider: string;
  collection: string;
  batchNo: number; // global across the run's collections
  afterId?: string; // exclusive; undefined = start of collection
  untilId: string; // inclusive
}

// Deterministic: re-dispatching the same batch yields the same BullMQ job id,
// so BullMQ deduplicates it instead of enqueuing it twice.
export function batchJobId(job: BatchJob): string {
  return `${job.runId}:${job.collection}:${job.batchNo}`;
}
