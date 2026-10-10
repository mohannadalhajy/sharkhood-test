import { StageName } from '../pipeline/stage';

export interface QuarantineEntry {
  runId: string;
  jobId?: string;
  collection: string;
  rawId: string;
  recordIndex?: number; // set when one record of a multi-record doc failed
  stage: StageName;
  reason: string;
}

export interface QuarantineRecord extends QuarantineEntry {
  createdAt: Date;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface QuarantineRepository {
  // Upsert on (runId, collection, rawId, recordIndex, stage) so a retried
  // job does not duplicate entries.
  addMany(entries: QuarantineEntry[]): Promise<void>;
  findByRun(
    runId: string,
    page: { offset: number; limit: number },
  ): Promise<Page<QuarantineRecord>>;
}
