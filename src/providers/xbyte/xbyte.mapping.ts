import { FieldMapping } from '../../core/transform/field-mapping';
import {
  collapseWhitespace,
  stripQuery,
  toGeoPoint,
  toInt,
  toNumber,
  zeroToNull,
} from '../../core/transform/transforms';
import {
  parseDeliveryTime,
  restaurantIdFromUrl,
  toCategories,
} from './xbyte.transforms';

// Declarative mappings: target field <- path in the extracted record.
// Required (non-optional) fields are the ones an entity cannot exist without.

export const areaMapping: FieldMapping = {
  externalId: { from: 'location_id', transform: [toInt] },
  name: { from: 'location_name', transform: [collapseWhitespace] },
  slug: { from: 'location_slug' },
};

export const listingRestaurantMapping: FieldMapping = {
  externalId: { from: 'restaurant_url', transform: [restaurantIdFromUrl] },
  url: { from: 'restaurant_url', transform: [stripQuery] },
  'sources.listing.name': {
    from: 'restaurant_name',
    transform: [collapseWhitespace],
  },
  areaIds: { from: 'areaId', transform: [toInt] },
};

export const menuRestaurantMapping: FieldMapping = {
  externalId: { from: 'restaurantUrl', transform: [restaurantIdFromUrl] },
  'sources.menu.name': { from: 'name', transform: [collapseWhitespace] },
  logo: { from: 'logo', optional: true },
  platformInternalId: { from: 'id', transform: [toInt], optional: true },
  location: { from: 'coords', transform: [toGeoPoint], optional: true },
  rating: { from: 'rate', transform: [toNumber], optional: true },
  ratingsCount: { from: 'totalRatings', transform: [toInt], optional: true },
  deliveryFee: { from: 'deliveryFee', transform: [toNumber], optional: true },
  deliveryTime: {
    from: 'DeliveryTime',
    transform: [parseDeliveryTime],
    optional: true,
  },
  minimumOrder: {
    from: 'Minimum Order',
    transform: [toNumber],
    optional: true,
  },
  city: { from: 'City', optional: true },
  addressText: { from: 'Restaurant Address', optional: true },
  categories: { from: 'category', transform: [toCategories] },
};

export const menuItemMapping: FieldMapping = {
  restaurantExternalId: {
    from: 'restaurantUrl',
    transform: [restaurantIdFromUrl],
  },
  externalId: { from: 'item_id', transform: [toInt] },
  name: { from: 'item_name', transform: [collapseWhitespace] },
  description: { from: 'description', optional: true },
  price: { from: 'price', transform: [toNumber] },
  image: { from: 'image', optional: true },
  rating: { from: 'rating', transform: [toNumber, zeroToNull], optional: true },
  categoryKeys: { from: 'categoryKeys' },
};
