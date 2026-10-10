import { StageCounters } from '../pipeline/stage';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RunCounters {
  read: number;
  transformed: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface Run {
  id: string;
  provider: string;
  status: RunStatus;
  counters: RunCounters;
  stages: StageCounters;
  checkpoints: Record<string, string>; // collection -> last processed _id
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
  saveCheckpoint(id: string, collection: string, lastId: string): Promise<void>;
}
