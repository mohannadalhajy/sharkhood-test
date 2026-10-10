export const FACTORY_QUEUE = 'factory-batches';
export const FACTORY_DLQ = 'factory-batches-dlq';

// Job names on FACTORY_QUEUE.
export const DISPATCH_JOB = 'dispatch';
export const BATCH_JOB = 'batch';

export interface DispatchJobData {
  runId: string;
}

// BullMQ only allows ':' in custom ids with exactly 3 parts, so this one
// uses '-'.
export const dispatchJobId = (runId: string) => `dispatch-${runId}`;
