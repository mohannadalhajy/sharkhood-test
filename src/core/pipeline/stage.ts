export type StageName =
  'validate' | 'extract' | 'normalise' | 'map' | 'deduplicate' | 'project';

export type StageResult<T> =
  { ok: true; value: T } | { ok: false; stage: StageName; reason: string };

// One pipeline step. Must be pure: no I/O, no clock, no randomness.
// Anything time- or source-dependent (fetchedAt, rawId) arrives as input.
export type Stage<I, O> = (input: I) => StageResult<O>;

export interface StageCounter {
  in: number;
  out: number;
  failed: number;
}

export type StageCounters = Record<StageName, StageCounter>;
