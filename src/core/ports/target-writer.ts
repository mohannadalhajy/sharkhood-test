import { Entity, NaturalKey } from '../pipeline/entity';

export interface SourceRef {
  provider: string;
  platform: string;
  rawId: string;
  fetchedAt: Date;
  slot?: string; // per-source freshness record (restaurants)
}

export interface EntityUpsert {
  entity: string;
  key: NaturalKey; // includes provider + platform
  set: Entity; // owned fields; applied only if `source` is newer
  addToSet?: Record<string, unknown[]>; // applied unconditionally
  source: SourceRef;
}

export interface WriteSummary {
  upserted: number;
  modified: number;
  unchanged: number; // matched but older/equal source, or identical data
}

// Upserts by natural key. Must be idempotent: replaying the same batch
// leaves the target unchanged.
export interface TargetWriter {
  upsertMany(upserts: EntityUpsert[]): Promise<WriteSummary>;
}
