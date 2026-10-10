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
  total: number;
  done: number;
  failed: number;
}

// Where the dispatcher stopped paging, so a restarted dispatcher continues
// with the same batch numbers (and therefore the same job ids).
export interface DispatchCursor {
  collection: string;
  afterId?: string;
  batchNo: number;
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

export interface RunRepository {
  create(provider: string): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  setStatus(id: string, status: RunStatus, error?: string): Promise<void>;
  addCounters(
    id: string,
    delta: { counters: Partial<RunCounters>; stages?: Partial<StageCounters> },
  ): Promise<void>;
  saveDispatchCursor(id: string, cursor: DispatchCursor): Promise<void>;
  // $inc jobs.done or jobs.failed, and in the same atomic update set status
  // 'completed' once done + failed == total. Returns the updated run.
  completeJob(id: string, outcome: JobOutcome): Promise<Run>;
}
