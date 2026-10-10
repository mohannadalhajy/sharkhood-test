import { z } from 'zod';
import { RawDocument } from '../ports/raw-source-reader';
import { EntityUpsert } from '../ports/target-writer';
import {
  OutputDefinition,
  ProviderAdapter,
  SourceDefinition,
} from '../provider/provider-adapter';
import { mapStage, normaliseStage } from '../transform/field-mapping';
import { Entity, NaturalKey } from './entity';
import { Stage, StageCounters, StageName } from './stage';

// Runs one batch of raw documents through
//   validate -> extract -> normalise -> map -> deduplicate -> project.
// Pure: same docs in, same result out. I/O (reading, writing, quarantine)
// stays with the caller.

export interface StageFailure {
  rawId: string;
  entity?: string;
  recordIndex?: number;
  stage: StageName;
  reason: string;
}

export interface BatchResult {
  upserts: EntityUpsert[];
  failures: StageFailure[]; // to be quarantined by the caller
  counters: StageCounters;
}

// A mapped entity plus where it came from.
interface Candidate {
  output: OutputDefinition<unknown, unknown>;
  entity: Entity;
  key: NaturalKey;
  rawId: string;
  fetchedAt: Date;
}

export function runBatch(
  adapter: ProviderAdapter,
  source: SourceDefinition<unknown>,
  docs: RawDocument[],
): BatchResult {
  const counters = emptyCounters();
  const failures: StageFailure[] = [];
  const candidates: Candidate[] = [];
  const validate = validateStage(source.schema);

  for (const doc of docs) {
    counters.validate.in++;
    const envelope = validate(doc.body);
    if (envelope.ok === false) {
      counters.validate.failed++;
      failures.push({
        rawId: doc.id,
        stage: envelope.stage,
        reason: envelope.reason,
      });
      continue;
    }
    counters.validate.out++;
    const fetchedAt = source.fetchedAt(envelope.value);

    for (const output of source.outputs) {
      counters.extract.in++;
      const records = extractStage(output)(envelope.value);
      if (records.ok === false) {
        counters.extract.failed++;
        failures.push({
          rawId: doc.id,
          entity: output.entity,
          stage: records.stage,
          reason: records.reason,
        });
        continue;
      }
      counters.extract.out += records.value.length;

      const normalise = normaliseStage(output.mapping);
      const map = mapStage(output.mapping);
      records.value.forEach((record, recordIndex) => {
        const fail = (stage: StageName, reason: string) =>
          failures.push({
            rawId: doc.id,
            entity: output.entity,
            recordIndex,
            stage,
            reason,
          });

        counters.normalise.in++;
        const normalised = normalise(record);
        if (normalised.ok === false) {
          counters.normalise.failed++;
          return fail(normalised.stage, normalised.reason);
        }
        counters.normalise.out++;

        counters.map.in++;
        const entity = map(normalised.value);
        if (entity.ok === false) {
          counters.map.failed++;
          return fail(entity.stage, entity.reason);
        }
        counters.map.out++;

        candidates.push({
          output,
          entity: entity.value,
          key: output.naturalKey(entity.value),
          rawId: doc.id,
          fetchedAt,
        });
      });
    }
  }

  counters.deduplicate.in = candidates.length;
  const deduplicated = deduplicate(candidates);
  counters.deduplicate.out = deduplicated.length;

  const project = projectStage(adapter);
  const upserts: EntityUpsert[] = [];
  for (const candidate of deduplicated) {
    counters.project.in++;
    const upsert = project(candidate);
    if (upsert.ok === false) {
      counters.project.failed++;
      failures.push({
        rawId: candidate.rawId,
        entity: candidate.output.entity,
        stage: upsert.stage,
        reason: upsert.reason,
      });
      continue;
    }
    counters.project.out++;
    upserts.push(upsert.value);
  }

  return { upserts, failures, counters };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export function validateStage<E>(schema: z.ZodType<E>): Stage<unknown, E> {
  return (body) => {
    const result = schema.safeParse(body);
    if (result.success) return { ok: true, value: result.data };
    const reason = result.error.issues
      .map((i) =>
        i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
      )
      .join('; ');
    return { ok: false, stage: 'validate', reason };
  };
}

// Provider code: a throw here is turned into a failure for this envelope
// instead of failing the whole batch.
function extractStage<E, R>(output: OutputDefinition<E, R>): Stage<E, R[]> {
  return (envelope) => {
    try {
      return { ok: true, value: output.extract(envelope) };
    } catch (err) {
      return {
        ok: false,
        stage: 'extract',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// Per batch, one survivor per (entity, source slot, natural key):
// - winner envelope = newest fetchedAt, tie -> larger rawId (conflict rule),
//   so the result does not depend on document order;
// - within the winner envelope, the first occurrence wins and
//   `unionOnMerge` arrays are unioned (always an array, nulls dropped);
// - `addToSet` arrays are unioned across all envelopes (order-independent).
function deduplicate(candidates: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const id = JSON.stringify([
      c.output.entity,
      c.output.sourceSlot ?? null,
      c.key,
    ]);
    const group = groups.get(id);
    if (group) group.push(c);
    else groups.set(id, [c]);
  }

  return [...groups.values()].map((group) => {
    const winner = group.reduce((best, c) => (isNewer(c, best) ? c : best));
    const fromWinner = group.filter((c) => c.rawId === winner.rawId);
    const first = fromWinner[0];
    const entity = { ...first.entity };
    for (const field of first.output.unionOnMerge ?? []) {
      entity[field] = union(fromWinner.map((c) => c.entity[field]));
    }
    for (const field of first.output.addToSet ?? []) {
      entity[field] = union(group.map((c) => c.entity[field]));
    }
    return { ...first, entity };
  });
}

function projectStage(
  adapter: ProviderAdapter,
): Stage<Candidate, EntityUpsert> {
  return ({ output, entity, key, rawId, fetchedAt }) => {
    for (const [field, value] of Object.entries(key)) {
      if (value === null || value === undefined) {
        return {
          ok: false,
          stage: 'project',
          reason: `natural key field ${field} is empty`,
        };
      }
    }
    const addToSetFields = output.addToSet ?? [];
    const set: Entity = {};
    for (const [field, value] of Object.entries(entity)) {
      if (!(field in key) && !addToSetFields.includes(field))
        set[field] = value;
    }
    const upsert: EntityUpsert = {
      entity: output.entity,
      key: { provider: adapter.name, platform: adapter.platform, ...key },
      set,
      source: {
        provider: adapter.name,
        platform: adapter.platform,
        rawId,
        fetchedAt,
        ...(output.sourceSlot ? { slot: output.sourceSlot } : {}),
      },
    };
    if (addToSetFields.length > 0) {
      upsert.addToSet = Object.fromEntries(
        addToSetFields.map((f) => [f, union([entity[f]])]),
      );
    }
    if (output.derived) upsert.derived = output.derived;
    return { ok: true, value: upsert };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNewer(a: Candidate, b: Candidate): boolean {
  const diff = a.fetchedAt.getTime() - b.fetchedAt.getTime();
  return diff !== 0 ? diff > 0 : a.rawId > b.rawId;
}

// Flattens scalars/arrays into one array without duplicates, keeping the
// order of first appearance; null/undefined are dropped.
function union(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values.flatMap((v) => (Array.isArray(v) ? v : [v]))) {
    if (value === null || value === undefined) continue;
    const id = JSON.stringify(value);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(value);
    }
  }
  return out;
}

function emptyCounters(): StageCounters {
  const zero = () => ({ in: 0, out: 0, failed: 0 });
  return {
    validate: zero(),
    extract: zero(),
    normalise: zero(),
    map: zero(),
    deduplicate: zero(),
    project: zero(),
  };
}
