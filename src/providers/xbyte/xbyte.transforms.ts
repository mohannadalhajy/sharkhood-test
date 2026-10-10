import { Transform, TransformResult } from '../../core/transform/field-mapping';

// xbyte/talabat-specific value transforms. All pure.

const ok = (value: unknown): TransformResult => ({ ok: true, value });
const fail = (reason: string): TransformResult => ({ ok: false, reason });

// ".../uae/restaurant/722864/some-slug?aid=1280" -> 722864
const RESTAURANT_ID_IN_URL = /\/restaurant\/(\d+)(?:[/?]|$)/;

export const restaurantIdFromUrl: Transform = (value) => {
  const match =
    typeof value === 'string' ? value.match(RESTAURANT_ID_IN_URL) : null;
  return match
    ? ok(Number(match[1]))
    : fail(`no restaurant id in ${JSON.stringify(value)}`);
};

// "25-40 mins" -> { min: 25, max: 40 }; "30 mins" -> { min: 30, max: 30 }
const DELIVERY_TIME = /^(\d+)\s*(?:-\s*(\d+))?\s*mins?$/i;

export const parseDeliveryTime: Transform = (value) => {
  const match = typeof value === 'string' ? value.match(DELIVERY_TIME) : null;
  if (!match)
    return fail(`unrecognised delivery time ${JSON.stringify(value)}`);
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  return min <= max
    ? ok({ min, max })
    : fail(`min > max in ${JSON.stringify(value)}`);
};

// category_id is not unique within a restaurant (same id, different names),
// so the key combines id and normalised name.
export function categoryKey(categoryId: number, name: string): string {
  return `${categoryId}:${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

interface RawCategory {
  category_id: number;
  category_name: string;
}

// Raw category[] (already validated by the schema) -> embedded categories.
export const toCategories: Transform = (value) => {
  if (!Array.isArray(value)) return fail('expected an array of categories');
  return ok(
    (value as RawCategory[]).map((c, position) => ({
      key: categoryKey(c.category_id, c.category_name),
      categoryId: c.category_id,
      name: c.category_name.trim().replace(/\s+/g, ' '),
      position,
    })),
  );
};
