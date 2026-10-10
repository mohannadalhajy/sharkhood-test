import { z } from 'zod';
import { Entity, NaturalKey } from '../pipeline/entity';
import { FieldMapping } from '../transform/field-mapping';

// The seam: a provider is a set of declarations. Core never imports from
// src/providers; adapters are handed to the runner.
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
  fetchedAt(envelope: E): Date; // input to the conflict rule
  readonly outputs: OutputDefinition<E, any>[];
}

export interface OutputDefinition<E, R> {
  readonly entity: string; // target entity type, e.g. 'menu_item'
  extract(envelope: E): R[]; // extract stage (pure fan-out)
  readonly mapping: FieldMapping; // normalise + map stages
  naturalKey(entity: Entity): NaturalKey; // without provider/platform
  // Deduplicate: duplicates from the winning envelope keep the first
  // occurrence, except these array fields, which are unioned.
  readonly unionOnMerge?: string[];
  // Freshness slot for entities fed by several sources ('listing', 'menu').
  readonly sourceSlot?: string;
  // Order-independent fields written with $addToSet, outside the guard.
  readonly addToSet?: string[];
  // Fields computed by the writer from stored state: first non-null path
  // wins, e.g. name <- ['sources.menu.name', 'sources.listing.name'].
  readonly derived?: Record<string, string[]>;
}
