import { Entity, NaturalKey } from '../pipeline/entity';

export interface SourceRef {
  provider: string;
  platform: string;
  rawId: string;
  fetchedAt: Date;
  slot?: string; // per-source freshness record: sources.<slot> instead of source
}

export interface EntityUpsert {
  entity: string;
  key: NaturalKey; // includes provider + platform
  set: Entity; // owned fields (dot paths allowed), guarded by freshness
  addToSet?: Record<string, unknown[]>; // order-independent, unguarded
  derived?: Record<string, string[]>; // field <- first non-null of these paths
  source: SourceRef;
}

export interface WriteSummary {
  upserted: number;
  modified: number;
  unchanged: number; // stale source, or identical data
}

// Upserts by natural key. Replaying the same upserts must leave the target
// unchanged. Implementations follow this contract per EntityUpsert:
//
// 1. addToSet: a separate, unconditional update
//    (upsert, `$addToSet: { field: { $each: values } }`). Set union gives the
//    same result in any order, so it needs no freshness guard.
//
// 2. set: an upsert whose filter is `key` AND a freshness guard on the
//    source record R = `sources.<slot>` (or `source` when there is no slot):
//      R does not exist
//      OR R.fetchedAt < new fetchedAt
//      OR (R.fetchedAt == new fetchedAt AND R.rawId < new rawId)
//    rawIds are ObjectId hex strings, so string order = _id order.
//    The `R does not exist` branch lets a second source write into a doc
//    the first source created. The update writes `set` and R = {rawId,
//    fetchedAt}, then recomputes `derived` fields in the same update
//    pipeline (values wrapped in $literal so strings starting with "$" are
//    not read as field paths).
//
// 3. When the guard does not match an existing doc, the upsert tries to
//    insert and fails with E11000 on the unique key. Retry that op once:
//    the doc may have been inserted concurrently, and the guard can now
//    match. A second E11000 means the stored source is newer: count it as
//    unchanged.
export interface TargetWriter {
  upsertMany(upserts: EntityUpsert[]): Promise<WriteSummary>;
}
