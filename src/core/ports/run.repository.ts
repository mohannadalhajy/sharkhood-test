import { StageCounters } from '../pipeline/stage';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors' // all jobs finished, some permanently failed
  | 'failed'; // the run itself failed (dispatch)
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

// One entry of the run's error sample (first N failures, for a quick look;
// the full list is in quarantine).
export interface ErrorSample {
  collection: string;
  jobId: string;
  rawId?: string;
  stage?: string; // pipeline stage, or undefined for a failed job
  reason: string;
}

export interface Run {
  id: string;
  provider: string;
  status: RunStatus;
  counters: RunCounters;
  stages: StageCounters;
  jobs: RunJobs;
  dispatchCursor?: DispatchCursor;
  errorSample: ErrorSample[];
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  error?: string;
}

export interface JobDelta {
  counters?: RunCounters;
  stages?: StageCounters;
  errors?: ErrorSample[]; // appended to errorSample, capped
}

export interface RunRepository {
  create(provider: string): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  setStatus(id: string, status: RunStatus, error?: string): Promise<void>;
  saveDispatchCursor(id: string, cursor: DispatchCursor): Promise<void>;
  // Sets jobs.total and runs the completion check (all jobs may already
  // have finished while the dispatcher was still enqueuing).
  setJobsTotal(id: string, total: number): Promise<void>;
  // One atomic update: $inc jobs.done/failed and the counters, append to
  // errorSample, and once done + failed == total set status 'completed'
  // (or 'completed_with_errors' if any job failed). Applied at most once per
  // jobId, so a retried or stalled job cannot double count.
  completeJob(
    id: string,
    jobId: string,
    outcome: JobOutcome,
    delta?: JobDelta,
  ): Promise<void>;
}
