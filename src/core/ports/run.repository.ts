import { StageCounters } from '../pipeline/stage';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type JobOutcome = 'done' | 'failed';

export interface RunCounters {
  read: number;
  transformed: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface RunJobs {
  total: number | null; // null until the dispatcher has enqueued every job
  done: number;
  failed: number;
}

// Where the dispatcher stopped, so a restarted dispatcher continues with
// the same batch numbers (and therefore the same job ids).
export interface DispatchCursor {
  collection: string;
  afterId?: string;
  batchNo: number; // next batch number
}

export interface Run {
  id: string;
  provider: string;
  status: RunStatus;
  counters: RunCounters;
  stages: StageCounters;
  jobs: RunJobs;
  dispatchCursor?: DispatchCursor;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  error?: string;
}

export interface JobDelta {
  counters: RunCounters;
  stages: StageCounters;
}

export interface RunRepository {
  create(provider: string): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  setStatus(id: string, status: RunStatus, error?: string): Promise<void>;
  saveDispatchCursor(id: string, cursor: DispatchCursor): Promise<void>;
  // Sets jobs.total and runs the completion check (all jobs may already
  // have finished while the dispatcher was still enqueuing).
  setJobsTotal(id: string, total: number): Promise<void>;
  // One atomic update: $inc jobs.done/failed and the counters, and set
  // status 'completed' once done + failed == total. Applied at most once per
  // jobId, so a retried or stalled job cannot double count.
  completeJob(
    id: string,
    jobId: string,
    outcome: JobOutcome,
    delta?: JobDelta,
  ): Promise<void>;
}
