import { z } from 'zod';
import { RawDocument } from '../ports/raw-source-reader';
import {
  ProviderAdapter,
  SourceDefinition,
} from '../provider/provider-adapter';
import { collapseWhitespace, toInt, toNumber } from '../transform/transforms';
import { runBatch } from './runner';

// A minimal fake provider: core tests must not depend on a real adapter.
const schema = z.object({
  fetchedAt: z.date(),
  shopId: z.number(),
  products: z.array(z.record(z.string(), z.unknown())),
});
type Envelope = z.infer<typeof schema>;

const source: SourceDefinition<Envelope> = {
  collection: 'raw-shops',
  schema,
  fetchedAt: (env) => env.fetchedAt,
  outputs: [
    {
      entity: 'product',
      extract: (env) => env.products.map((p) => ({ ...p, shopId: env.shopId })),
      mapping: {
        externalId: { from: 'id', transform: [toInt] },
        name: { from: 'name', transform: [collapseWhitespace] },
        price: { from: 'price', transform: [toNumber] },
        tags: { from: 'tags', optional: true },
        shopIds: { from: 'shopId' },
      },
      naturalKey: (e) => ({ externalId: e.externalId as number }),
      unionOnMerge: ['tags'],
      addToSet: ['shopIds'],
    },
  ],
};

const adapter: ProviderAdapter = {
  name: 'fake',
  platform: 'test',
  sources: [source],
};

const JULY = new Date('2026-07-01T00:00:00Z');
const SEPT = new Date('2026-09-01T00:00:00Z');

function doc(
  id: string,
  body: Partial<Envelope> & Record<string, unknown>,
): RawDocument {
  return { id, body: { fetchedAt: JULY, shopId: 1, products: [], ...body } };
}

describe('runBatch', () => {
  it('maps a valid document to upserts keyed by provider, platform and natural key', () => {
    const result = runBatch(adapter, source, [
      doc('a1', { products: [{ id: '7', name: ' Pad  Thai ', price: '6.5' }] }),
    ]);

    expect(result.failures).toEqual([]);
    expect(result.upserts).toEqual([
      {
        entity: 'product',
        key: { provider: 'fake', platform: 'test', externalId: 7 },
        set: { name: 'Pad Thai', price: 6.5, tags: [] }, // union fields are always arrays
        addToSet: { shopIds: [1] },
        source: {
          provider: 'fake',
          platform: 'test',
          rawId: 'a1',
          fetchedAt: JULY,
        },
      },
    ]);
  });

  it('quarantines failures with the stage that rejected them and keeps siblings', () => {
    const result = runBatch(adapter, source, [
      doc('bad-envelope', { products: 'not-an-array' as never }),
      doc('mixed', {
        products: [
          { id: 1, name: 'ok', price: 10 },
          { id: 2, name: 'bad price', price: 'free' }, // transform fails
          { id: 3, price: 5 }, // required name missing
          { id: 4, name: '   ', price: 5 }, // blank -> null -> missing
        ],
      }),
    ]);

    expect(result.upserts.map((u) => u.key.externalId)).toEqual([1]);
    expect(result.failures).toEqual([
      expect.objectContaining({ rawId: 'bad-envelope', stage: 'validate' }),
      expect.objectContaining({
        rawId: 'mixed',
        entity: 'product',
        recordIndex: 1,
        stage: 'normalise',
        reason: expect.stringContaining(
          'price (from price): expected a number',
        ),
      }),
      expect.objectContaining({ rawId: 'mixed', recordIndex: 2, stage: 'map' }),
      expect.objectContaining({ rawId: 'mixed', recordIndex: 3, stage: 'map' }),
    ]);
  });

  it('turns a throwing extract into an extract failure instead of crashing the batch', () => {
    const throwing: SourceDefinition<Envelope> = {
      ...source,
      outputs: [
        {
          ...source.outputs[0],
          extract: () => {
            throw new Error('boom');
          },
        },
      ],
    };
    const result = runBatch(adapter, throwing, [doc('a1', {})]);
    expect(result.failures).toEqual([
      { rawId: 'a1', entity: 'product', stage: 'extract', reason: 'boom' },
    ]);
  });

  it('counts in/out/failed per stage', () => {
    const result = runBatch(adapter, source, [
      doc('bad', { shopId: 'x' as never }),
      doc('a1', {
        products: [
          { id: 1, name: 'one', price: 1 },
          { id: 1, name: 'one again', price: 1 }, // duplicate key
          { id: 2, name: 'two', price: 'x' }, // normalise failure
          { id: 3, price: 3 }, // map failure
        ],
      }),
    ]);

    expect(result.counters).toEqual({
      validate: { in: 2, out: 1, failed: 1 },
      extract: { in: 1, out: 4, failed: 0 },
      normalise: { in: 4, out: 3, failed: 1 },
      map: { in: 3, out: 2, failed: 1 },
      deduplicate: { in: 2, out: 1, failed: 0 },
      project: { in: 1, out: 1, failed: 0 },
    });
  });

  describe('deduplicate (per batch, conflict rule)', () => {
    const older = doc('b', {
      fetchedAt: JULY,
      shopId: 1,
      products: [{ id: 9, name: 'old', price: 1, tags: ['x'] }],
    });
    const newer = doc('a', {
      fetchedAt: SEPT,
      shopId: 2,
      products: [
        { id: 9, name: 'new', price: 2, tags: ['offers'] },
        { id: 9, name: 'new (repeat)', price: 2, tags: ['mains'] },
      ],
    });

    it('keeps the newest fetchedAt regardless of document order', () => {
      for (const docs of [
        [older, newer],
        [newer, older],
      ]) {
        const [upsert] = runBatch(adapter, source, docs).upserts;
        expect(upsert.set.name).toBe('new'); // first occurrence in the winner
        expect(upsert.set.tags).toEqual(['offers', 'mains']); // unioned in winner only
        expect(upsert.addToSet.shopIds.sort()).toEqual([1, 2]); // across all envelopes
        expect(upsert.source.rawId).toBe('a');
      }
    });

    it('breaks a fetchedAt tie with the larger rawId', () => {
      const tieLow = doc('aaa', {
        fetchedAt: JULY,
        products: [{ id: 9, name: 'low', price: 1 }],
      });
      const tieHigh = doc('bbb', {
        fetchedAt: JULY,
        products: [{ id: 9, name: 'high', price: 1 }],
      });
      for (const docs of [
        [tieLow, tieHigh],
        [tieHigh, tieLow],
      ]) {
        expect(runBatch(adapter, source, docs).upserts[0].set.name).toBe(
          'high',
        );
      }
    });
  });

  it('is deterministic and does not mutate its input', () => {
    const docs = [
      doc('a1', {
        products: [{ id: 1, name: 'one', price: '1', tags: ['t'] }],
      }),
      doc('a2', {
        fetchedAt: SEPT,
        products: [{ id: 1, name: 'uno', price: 2 }],
      }),
      doc('a3', { products: [{ id: 2, price: 'x' }] }),
    ];
    const snapshot = structuredClone(docs);

    const first = runBatch(adapter, source, docs);
    const second = runBatch(adapter, source, docs);

    expect(second).toEqual(first);
    expect(docs).toEqual(snapshot);
  });
});
