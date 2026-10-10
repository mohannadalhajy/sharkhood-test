import {
  categoryKey,
  parseDeliveryTime,
  restaurantIdFromUrl,
  toCategories,
} from './xbyte.transforms';

const URL =
  'https://www.talabat.com/uae/restaurant/722864/everyday-roastery-coffee-dh-kitchen-business-bay-sol-avenue?aid=1280';

describe('parseDeliveryTime', () => {
  it.each([
    ['25-40 mins', { min: 25, max: 40 }],
    ['30 mins', { min: 30, max: 30 }],
    ['20 - 35 mins', { min: 20, max: 35 }],
  ])('parses %j', (input, expected) => {
    expect(parseDeliveryTime(input)).toEqual({ ok: true, value: expected });
  });

  it.each(['soon', '', '40-25 mins', '30', 30, null])('rejects %j', (input) => {
    expect(parseDeliveryTime(input)).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });
});

describe('restaurantIdFromUrl', () => {
  it('extracts the numeric id from the path, ignoring ?aid=', () => {
    expect(restaurantIdFromUrl(URL)).toEqual({ ok: true, value: 722864 });
  });

  it('gives the same id for the same restaurant listed under another area', () => {
    expect(restaurantIdFromUrl(URL.replace('aid=1280', 'aid=1468'))).toEqual({
      ok: true,
      value: 722864,
    });
  });

  it.each([
    'https://www.talabat.com/uae/restaurants',
    'https://www.talabat.com/uae/restaurant/abc/slug',
    42,
  ])('rejects %j', (input) => {
    expect(restaurantIdFromUrl(input)).toEqual({
      ok: false,
      reason: expect.stringContaining('no restaurant id'),
    });
  });
});

describe('categoryKey', () => {
  it('gives two keys for one category_id reused with two names', () => {
    expect(categoryKey(2583617858, 'Offers')).not.toBe(
      categoryKey(2583617858, 'Add On'),
    );
  });

  it('ignores case and whitespace differences in the name', () => {
    expect(categoryKey(1, '  Picks  for you 🔥 ')).toBe(
      categoryKey(1, 'picks for you 🔥'),
    );
  });
});

describe('toCategories', () => {
  it('keeps order as position and builds keys', () => {
    expect(
      toCategories([
        { category_id: 7, category_name: 'Picks for you 🔥', items: [] },
        { category_id: 7, category_name: ' Bites ', items: [] },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          key: '7:picks for you 🔥',
          categoryId: 7,
          name: 'Picks for you 🔥',
          position: 0,
        },
        { key: '7:bites', categoryId: 7, name: 'Bites', position: 1 },
      ],
    });
  });
});
