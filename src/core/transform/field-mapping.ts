import { Entity } from '../pipeline/entity';
import { Stage } from '../pipeline/stage';

// Declarative field mapping: target field <- source path (+ transforms).
// Providers declare specs; this file is the engine that applies them.

export type TransformResult =
  { ok: true; value: unknown } | { ok: false; reason: string };

// Pure value converter, e.g. "9" -> 9, "25-40 mins" -> { min: 25, max: 40 }.
export type Transform = (value: unknown) => TransformResult;

export interface FieldSpec {
  from: string; // dot path in the extracted record
  transform?: Transform[]; // applied in order; first failure fails the record
  optional?: boolean; // missing/null -> null instead of a failure
}

// Key = target field; dot paths (e.g. 'sources.menu.name') are kept as-is.
export type FieldMapping = Record<string, FieldSpec>;

// Values per target field, before required-field checks.
export type NormalisedRecord = Record<string, unknown>;

// normalise: read each source path, trim strings (blank -> null), then run
// the field's transforms. A transform failure fails the record here.
export function normaliseStage(
  mapping: FieldMapping,
): Stage<unknown, NormalisedRecord> {
  return (record) => {
    const out: NormalisedRecord = {};
    for (const [target, spec] of Object.entries(mapping)) {
      let value = clean(readPath(record, spec.from));
      for (const transform of spec.transform ?? []) {
        if (value === null) break;
        let result: TransformResult;
        try {
          result = transform(value);
        } catch (err) {
          result = { ok: false, reason: errorMessage(err) };
        }
        if (result.ok === false) {
          return {
            ok: false,
            stage: 'normalise',
            reason: `${target} (from ${spec.from}): ${result.reason}`,
          };
        }
        value = result.value;
      }
      out[target] = value;
    }
    return { ok: true, value: out };
  };
}

// map: assemble the entity. A required field that is missing/null (in the
// source, or after normalising) fails the record here.
export function mapStage(
  mapping: FieldMapping,
): Stage<NormalisedRecord, Entity> {
  return (normalised) => {
    const entity: Entity = {};
    for (const [target, spec] of Object.entries(mapping)) {
      const value = normalised[target] ?? null;
      if (value === null && !spec.optional) {
        return {
          ok: false,
          stage: 'map',
          reason: `${target}: required path "${spec.from}" is missing or empty`,
        };
      }
      entity[target] = value;
    }
    return { ok: true, value: entity };
  };
}

function readPath(record: unknown, path: string): unknown {
  let current = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// Baseline cleanup for every provider: undefined -> null, trim strings,
// blank strings -> null.
function clean(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
