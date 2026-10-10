import { z } from 'zod';
import { Entity, NaturalKey } from '../pipeline/entity';
import { FieldMapping } from '../transform/field-mapping';

// The seam: a provider is a set of declarations. The engine never imports
// anything from src/providers; adapters are registered with it.
export interface ProviderAdapter {
  readonly name: string; // e.g. 'xbyte'
  readonly platform: string; // e.g. 'talabat'
  readonly sources: SourceDefinition<any>[];
}

// One raw collection. One raw doc (envelope) can yield many records,
// possibly of several entity types (a menu -> restaurant + menu items).
export interface SourceDefinition<E> {
  readonly collection: string;
  readonly schema: z.ZodType<E>; // validate stage
  fetchedAt(envelope: E): Date; // freshness for the conflict rule
  readonly outputs: OutputDefinition<E, any>[];
}

export interface OutputDefinition<E, R> {
  readonly entity: string; // target entity type, e.g. 'menu_item'
  extract(envelope: E): R[]; // extract stage (pure fan-out)
  readonly mapping: FieldMapping; // map stage
  naturalKey(entity: Entity): NaturalKey; // without provider/platform
  // Deduplicate stage (within one envelope): first occurrence wins,
  // except these array fields, which are unioned.
  readonly unionOnMerge?: string[];
  // Freshness slot for entities fed by several sources ('listing', 'menu').
  readonly sourceSlot?: string;
  // Order-independent fields written with $addToSet, outside the freshness guard.
  readonly addToSet?: string[];
}
