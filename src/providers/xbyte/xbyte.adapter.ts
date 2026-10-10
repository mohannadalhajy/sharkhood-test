import {
  ProviderAdapter,
  SourceDefinition,
} from '../../core/provider/provider-adapter';
import {
  areaMapping,
  listingRestaurantMapping,
  menuItemMapping,
  menuRestaurantMapping,
} from './xbyte.mapping';
import {
  LocationsEnvelope,
  locationsSchema,
  MenusEnvelope,
  menusSchema,
  PLATFORM,
  RestaurantsEnvelope,
  restaurantsSchema,
} from './xbyte.schemas';
import { categoryKey } from './xbyte.transforms';

// Fields written by both sources resolve by a fixed preference, from the
// stored per-source values: the result does not depend on write order.
const restaurantDerived = {
  name: ['sources.menu.name', 'sources.listing.name'],
  url: ['sources.listing.url', 'sources.menu.url'],
};

const locations: SourceDefinition<LocationsEnvelope> = {
  collection: 'compero-xbyte.xbyte-raw-locations',
  schema: locationsSchema,
  fetchedAt: (env) => env.createdAt,
  outputs: [
    {
      entity: 'area',
      extract: (env) => env.payload.results,
      mapping: areaMapping,
      naturalKey: (e) => ({ externalId: e.externalId as number }),
    },
  ],
};

const restaurants: SourceDefinition<RestaurantsEnvelope> = {
  collection: 'compero-xbyte.xbyte-raw-restaurants',
  schema: restaurantsSchema,
  fetchedAt: (env) => env.createdAt,
  outputs: [
    {
      entity: 'restaurant',
      // areaId lives on the request, not on each result.
      extract: (env) =>
        (env.payload.results ?? []).map((r) => ({
          ...r,
          areaId: env.params.areaId,
        })),
      mapping: listingRestaurantMapping,
      naturalKey: (e) => ({ externalId: e.externalId as number }),
      sourceSlot: 'listing',
      addToSet: ['areaIds'],
      derived: restaurantDerived,
    },
  ],
};

const menus: SourceDefinition<MenusEnvelope> = {
  collection: 'compero-xbyte.xbyte-raw-menus',
  schema: menusSchema,
  fetchedAt: (env) => env.createdAt,
  outputs: [
    {
      entity: 'restaurant',
      extract: (env) =>
        (env.payload.results ?? []).map((r) => ({
          ...r,
          restaurantUrl: env.params.restaurant_url,
          // toGeoPoint turns a missing/blank coordinate into location: null.
          coords: { lat: r.latitude, lng: r.longitude },
        })),
      mapping: menuRestaurantMapping,
      naturalKey: (e) => ({ externalId: e.externalId as number }),
      sourceSlot: 'menu',
      derived: restaurantDerived,
    },
    {
      entity: 'menu_item',
      // Items repeat across categories ("Offers", "Picks for you"); each
      // occurrence carries its category key and deduplicate unions them.
      extract: (env) =>
        (env.payload.results ?? []).flatMap((r) =>
          r.category.flatMap((c) =>
            c.items.map((item) => ({
              ...item,
              restaurantUrl: env.params.restaurant_url,
              categoryKeys: [categoryKey(c.category_id, c.category_name)],
            })),
          ),
        ),
      mapping: menuItemMapping,
      naturalKey: (e) => ({
        restaurantExternalId: e.restaurantExternalId as number,
        externalId: e.externalId as number,
      }),
      unionOnMerge: ['categoryKeys'],
    },
  ],
};

export const xbyteAdapter: ProviderAdapter = {
  name: 'xbyte',
  platform: PLATFORM,
  sources: [locations, restaurants, menus],
};
