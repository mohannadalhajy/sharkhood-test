import { between, nonNegative, toGeoPoint, toNumber } from './transforms';

describe('generic transforms', () => {
  it.each(['', '   ', 'abc', null, undefined, {}])(
    'toNumber rejects %j (a blank string is not 0)',
    (input) => {
      expect(toNumber(input)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
    },
  );

  it.each([
    [
      { lat: '25.17', lng: '55.24' },
      { type: 'Point', coordinates: [55.24, 25.17] },
    ],
    [{ lat: ' ', lng: '55.24' }, null],
    [{ lat: '25.17', lng: '' }, null],
    [{ lat: '25.17' }, null],
    [null, null],
  ])('toGeoPoint(%j) -> %j', (input, expected) => {
    expect(toGeoPoint(input)).toEqual({ ok: true, value: expected });
  });

  it('toGeoPoint rejects out-of-range coordinates', () => {
    expect(toGeoPoint({ lat: 95, lng: 10 }).ok).toBe(false);
  });

  it('between and nonNegative check ranges', () => {
    expect(between(0, 5)(5)).toEqual({ ok: true, value: 5 });
    expect(between(0, 5)(5.1).ok).toBe(false);
    expect(nonNegative(0)).toEqual({ ok: true, value: 0 });
    expect(nonNegative(-0.5).ok).toBe(false);
  });
});
