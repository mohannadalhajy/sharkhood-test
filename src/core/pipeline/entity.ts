// A mapped domain entity, still provider-agnostic: just named fields.
export type Entity = Record<string, unknown>;

// Fields that identify an entity across runs (upsert filter).
export type NaturalKey = Record<string, string | number>;
