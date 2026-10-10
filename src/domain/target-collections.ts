import { mongo } from 'mongoose';

// Entity type (as named by provider outputs) -> target collection.
export const ENTITY_COLLECTIONS: Record<string, string> = {
  area: 'areas',
  restaurant: 'restaurants',
  menu_item: 'menu_items',
};

export interface IndexDefinition {
  collection: string;
  key: mongo.IndexSpecification;
  options?: mongo.CreateIndexesOptions;
}

// See docs/ARCHITECTURE.md §4 for why each index exists.
export const TARGET_INDEXES: IndexDefinition[] = [
  {
    collection: 'areas',
    key: { provider: 1, platform: 1, externalId: 1 },
    options: { unique: true },
  },
  {
    collection: 'restaurants',
    key: { provider: 1, platform: 1, externalId: 1 },
    options: { unique: true },
  },
  { collection: 'restaurants', key: { areaIds: 1 } },
  { collection: 'restaurants', key: { location: '2dsphere' } },
  {
    collection: 'menu_items',
    key: { provider: 1, platform: 1, restaurantExternalId: 1, externalId: 1 },
    options: { unique: true },
  },
  {
    collection: 'menu_items',
    key: { restaurantExternalId: 1, categoryKeys: 1 },
  },
];
