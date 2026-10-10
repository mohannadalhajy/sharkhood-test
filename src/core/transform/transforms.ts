import { Transform, TransformResult } from './field-mapping';

// Generic, provider-agnostic value transforms. All pure.

const ok = (value: unknown): TransformResult => ({ ok: true, value });
const fail = (reason: string): TransformResult => ({ ok: false, reason });

// Accepts numbers and numeric strings ("9", "6.5").
export const toNumber: Transform = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n)
    ? ok(n)
    : fail(`expected a number, got ${JSON.stringify(value)}`);
};

export const toInt: Transform = (value) => {
  const result = toNumber(value);
  if (result.ok === false) return result;
  return Number.isInteger(result.value)
    ? result
    : fail(`expected an integer, got ${JSON.stringify(value)}`);
};

// "Al  Muntazah" -> "Al Muntazah"
export const collapseWhitespace: Transform = (value) =>
  typeof value === 'string'
    ? ok(value.replace(/\s+/g, ' '))
    : fail(`expected a string, got ${JSON.stringify(value)}`);

// For fields where 0 means "no data" (e.g. unrated).
export const zeroToNull: Transform = (value) => ok(value === 0 ? null : value);

// Drops the query string: "https://x/y?aid=1" -> "https://x/y".
export const stripQuery: Transform = (value) =>
  typeof value === 'string'
    ? ok(value.split('?')[0])
    : fail(`expected a string, got ${JSON.stringify(value)}`);

// { lat, lng } (numbers or numeric strings) -> GeoJSON Point [lng, lat].
export const toGeoPoint: Transform = (value) => {
  const { lat, lng } = (value ?? {}) as { lat?: unknown; lng?: unknown };
  const latResult = toNumber(lat);
  const lngResult = toNumber(lng);
  if (!latResult.ok || !lngResult.ok) {
    return fail(`invalid coordinates ${JSON.stringify(value)}`);
  }
  const latitude = latResult.value as number;
  const longitude = lngResult.value as number;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return fail(`coordinates out of range ${JSON.stringify(value)}`);
  }
  return ok({ type: 'Point', coordinates: [longitude, latitude] });
};
