// Declarative field mapping: target field <- source path (+ transforms).
// The engine that applies it lives in core; providers only declare specs.

export type TransformResult =
  { ok: true; value: unknown } | { ok: false; reason: string };

// Pure value converter, e.g. "9" -> 9, "25-40 mins" -> { min: 25, max: 40 }.
export type Transform = (value: unknown) => TransformResult;

export interface FieldSpec {
  from: string; // dot path in the extracted record
  transform?: Transform[]; // applied in order; first failure fails the record
  optional?: boolean; // missing/null -> null instead of a failure
}

export type FieldMapping = Record<string, FieldSpec>; // key = target field
