import { runBatch } from '../../core/pipeline/runner';
import { RawDocument } from '../../core/ports/raw-source-reader';
import { xbyteAdapter } from './xbyte.adapter';

// Fixtures follow the shape of the real raw docs (see docs/profile.md),
// trimmed to the fields that matter.

const FETCHED_AT = new Date('2026-07-22T08:11:56.249Z');
const MENU_URL =
  'https://www.talabat.com/uae/restaurant/34858/quick-burger-business-bay?aid=1280';

function source(collectionSuffix: string) {
  return xbyteAdapter.sources.find((s) =>
    s.collection.endsWith(collectionSuffix),
  );
}

function raw(id: string, body: Record<string, unknown>): RawDocument {
  return {
    id,
    body: {
      domain: 'talabat',
      statusCode: 200,
      createdAt: FETCHED_AT,
      ...body,
    },
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 2796833695,
    item_name: 'Classic Hotdog',
    description: 'Chicken hotdog with Mustard',
    price: 29,
    rating: 4,
    image: 'https://images.deliveryhero.io/image/talabat/MenuItems/EDBC88E7',
    ...overrides,
  };
}

function menuDoc(
  category: unknown[],
  restaurant: Record<string, unknown> = {},
) {
  return raw('6a607b4ca08982f2261e3948', {
    params: { restaurant_url: MENU_URL },
    payload: {
      results: [
        {
          id: 19770,
          name: 'Quick Burger',
          logo: 'https://images.deliveryhero.io/image/talabat/restaurants/logo.jpg',
          latitude: '25.179146290963214',
          longitude: '55.24161061023747',
          rate: 4.5,
          totalReviews: 0,
          totalRatings: 100,
          deliveryFee: '6.5',
          DeliveryTime: '25-40 mins',
          'Minimum Order': 20,
          'Restaurant Address': 'Business Bay',
          City: 'Dubai',
          Contact: '00000-00000',
          outletCode: 34858,
          category,
          ...restaurant,
        },
      ],
    },
  });
}

const menus = source('raw-menus');
const restaurants = source('raw-restaurants');

function upsertsOf(docs: RawDocument[], entity: string) {
  const result = runBatch(xbyteAdapter, menus, docs);
  expect(result.failures).toEqual([]);
  return result.upserts.filter((u) => u.entity === entity);
}

describe('xbyte adapter', () => {
  describe('soft failures', () => {
    it('rejects a menu whose payload says it is not a restaurant page', () => {
      const result = runBatch(xbyteAdapter, menus, [
        raw('m1', {
          params: { restaurant_url: MENU_URL },
          payload: { Message: 'This is not restaurant page (Talabat).' },
        }),
      ]);

      expect(result.upserts).toEqual([]);
      expect(result.failures).toEqual([
        {
          rawId: 'm1',
          stage: 'validate',
          reason:
            'payload: soft failure: provider says "This is not restaurant page (Talabat)."',
        },
      ]);
    });

    it('accepts an empty listing page ("Page limit exceeded" with results: [])', () => {
      const result = runBatch(xbyteAdapter, restaurants, [
        raw('r1', {
          params: {
            domain: 'talabat',
            areaSlug: 'al-zaab',
            areaId: '1468',
            page_no: 3,
          },
          payload: {
            'Total Page': 1,
            'Page Error Message': 'Page limit exceeded.',
            results: [],
          },
        }),
      ]);

      expect(result.failures).toEqual([]);
      expect(result.upserts).toEqual([]);
      expect(result.counters.validate).toEqual({ in: 1, out: 1, failed: 0 });
    });

    it('rejects a listing page without results', () => {
      const result = runBatch(xbyteAdapter, restaurants, [
        raw('r1', {
          params: {
            domain: 'talabat',
            areaSlug: 'al-zaab',
            areaId: '1468',
            page_no: 14,
          },
          payload: { error: '' },
        }),
      ]);

      expect(result.failures).toEqual([
        {
          rawId: 'r1',
          stage: 'validate',
          reason: 'payload: provider error: error field = "", no results',
        },
      ]);
    });
  });

  describe('listing restaurants', () => {
    it('parses areaId "1468" into areaIds, and takes the id and canonical url from the URL', () => {
      const result = runBatch(xbyteAdapter, restaurants, [
        raw('r1', {
          params: {
            domain: 'talabat',
            areaSlug: 'al-zaab',
            areaId: '1468',
            page_no: 0,
          },
          payload: {
            'Total Page': 227,
            results: [
              {
                area_name: 'Al Zaab',
                restaurant_name: 'Sla Restaurant and Cafe',
                restaurant_url:
                  'https://www.talabat.com/uae/restaurant/648607/sla-restaurant-and-cafe-al-rowdah?aid=1468',
              },
            ],
          },
        }),
      ]);

      expect(result.failures).toEqual([]);
      expect(result.upserts).toEqual([
        expect.objectContaining({
          entity: 'restaurant',
          key: { provider: 'xbyte', platform: 'talabat', externalId: 648607 },
          set: {
            'sources.listing.url':
              'https://www.talabat.com/uae/restaurant/648607/sla-restaurant-and-cafe-al-rowdah',
            'sources.listing.name': 'Sla Restaurant and Cafe',
          },
          addToSet: { areaIds: [1468] },
          source: expect.objectContaining({ slot: 'listing', rawId: 'r1' }),
        }),
      ]);
    });
  });

  describe('menu restaurant', () => {
    it('converts numeric strings to numbers and parses delivery time', () => {
      const [restaurant] = upsertsOf([menuDoc([])], 'restaurant');

      expect(restaurant.key).toEqual({
        provider: 'xbyte',
        platform: 'talabat',
        externalId: 34858,
      });
      expect(restaurant.set).toMatchObject({
        'sources.menu.name': 'Quick Burger',
        'sources.menu.url':
          'https://www.talabat.com/uae/restaurant/34858/quick-burger-business-bay',
        location: {
          type: 'Point',
          coordinates: [55.24161061023747, 25.179146290963214],
        },
        deliveryFee: 6.5,
        deliveryTime: { min: 25, max: 40 },
        minimumOrder: 20,
        categories: [],
      });
      expect(restaurant.source.slot).toBe('menu');
      expect(restaurant.derived).toEqual({
        name: ['sources.menu.name', 'sources.listing.name'],
        url: ['sources.listing.url', 'sources.menu.url'],
      });
    });

    it.each([
      ['blank latitude', { latitude: '   ' }],
      ['missing longitude', { longitude: undefined }],
    ])(
      'sets location to null for %s (never a 0 coordinate)',
      (_label, coords) => {
        const [restaurant] = upsertsOf([menuDoc([], coords)], 'restaurant');
        expect(restaurant.set.location).toBeNull();
      },
    );

    it('rejects a restaurant rating outside 0..5 at normalise', () => {
      const result = runBatch(xbyteAdapter, menus, [menuDoc([], { rate: 6 })]);
      expect(result.failures).toEqual([
        expect.objectContaining({
          entity: 'restaurant',
          stage: 'normalise',
          reason: expect.stringContaining('expected a number in [0, 5], got 6'),
        }),
      ]);
    });

    it('gives one category_id with two names two distinct keys', () => {
      const [restaurant] = upsertsOf(
        [
          menuDoc([
            { category_id: 2583617858, category_name: 'Offers', items: [] },
            { category_id: 2583617858, category_name: 'Add On', items: [] },
          ]),
        ],
        'restaurant',
      );

      expect(restaurant.set.categories).toEqual([
        {
          key: '2583617858:offers',
          categoryId: 2583617858,
          name: 'Offers',
          position: 0,
        },
        {
          key: '2583617858:add on',
          categoryId: 2583617858,
          name: 'Add On',
          position: 1,
        },
      ]);
    });
  });

  describe('menu items', () => {
    it('merges the same item_id from two categories into one item with both keys', () => {
      const items = upsertsOf(
        [
          menuDoc([
            {
              category_id: 2796833705,
              category_name: 'Picks for you 🔥',
              items: [item()],
            },
            {
              category_id: 2796833706,
              category_name: 'Bites',
              items: [item()],
            },
          ]),
        ],
        'menu_item',
      );

      expect(items).toHaveLength(1);
      expect(items[0].key).toEqual({
        provider: 'xbyte',
        platform: 'talabat',
        restaurantExternalId: 34858,
        externalId: 2796833695,
      });
      expect(items[0].set.categoryKeys).toEqual([
        '2796833705:picks for you 🔥',
        '2796833706:bites',
      ]);
    });

    it('maps rating 0 to null, blank description to null and numeric strings to numbers', () => {
      const [menuItem] = upsertsOf(
        [
          menuDoc([
            {
              category_id: 1,
              category_name: 'Mains',
              items: [
                item({
                  rating: 0,
                  description: '   ',
                  price: '26.5',
                  image: null,
                }),
              ],
            },
          ]),
        ],
        'menu_item',
      );

      expect(menuItem.set).toEqual({
        name: 'Classic Hotdog',
        description: null,
        price: 26.5,
        image: null,
        rating: null,
        categoryKeys: ['1:mains'],
      });
    });

    it('quarantines only the item with a bad price', () => {
      const result = runBatch(xbyteAdapter, menus, [
        menuDoc([
          {
            category_id: 1,
            category_name: 'Mains',
            items: [
              item({ item_id: 1 }),
              item({ item_id: 2, price: 'free' }),
              item({ item_id: 3, price: -5 }),
              item({ item_id: 4, price: '  ' }), // blank is not 0
            ],
          },
        ]),
      ]);

      expect(
        result.upserts
          .filter((u) => u.entity === 'menu_item')
          .map((u) => u.key.externalId),
      ).toEqual([1]);
      expect(result.failures).toEqual([
        expect.objectContaining({ recordIndex: 1, stage: 'normalise' }),
        expect.objectContaining({
          recordIndex: 2,
          stage: 'normalise',
          reason: expect.stringContaining('expected a number >= 0, got -5'),
        }),
        // Blank is cleaned to null first, so it is a missing required price.
        expect.objectContaining({ recordIndex: 3, stage: 'map' }),
      ]);
    });
  });
});
