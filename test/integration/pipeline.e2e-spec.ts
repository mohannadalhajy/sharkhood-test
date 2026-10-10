import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, mongo } from 'mongoose';
import { BatchJob, batchJobId } from '../../src/core/pipeline/batch-job';
import { Run, RunRepository } from '../../src/core/ports/run.repository';
import {
  QUARANTINE_REPOSITORY,
  RAW_SOURCE_READER,
  RUN_REPOSITORY,
  TARGET_WRITER,
} from '../../src/core/ports/tokens';
import {
  RAW_CONNECTION,
  TARGET_CONNECTION,
} from '../../src/database/database.constants';
import { MongoRawSourceReader } from '../../src/database/mongo-raw-source-reader';
import { MongoTargetWriter } from '../../src/domain/mongo-target-writer';
import {
  PROVIDER_ADAPTERS,
  ProviderRegistry,
} from '../../src/providers/provider-registry';
import { xbyteAdapter } from '../../src/providers/xbyte/xbyte.adapter';
import { BatchService } from '../../src/queue/batch.service';
import { DispatcherService } from '../../src/queue/dispatcher.service';
import { FACTORY_QUEUE } from '../../src/queue/queue.constants';
import { MongoQuarantineRepository } from '../../src/runs/mongo-quarantine.repository';
import { MongoRunRepository } from '../../src/runs/mongo-run.repository';

// Full pipeline against an in-memory Mongo: real dispatcher, real batch
// processor, real Mongo adapters. Only the BullMQ queue is faked: it records
// the jobs the dispatcher enqueues, and the test runs them directly.

const LOCATIONS = 'compero-xbyte.xbyte-raw-locations';
const RESTAURANTS = 'compero-xbyte.xbyte-raw-restaurants';
const MENUS = 'compero-xbyte.xbyte-raw-menus';
const BATCH_SIZE = 2; // small, so the fixture spans several jobs

const oid = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'));
const url = (id: number, slug: string, aid: number) =>
  `https://www.talabat.com/uae/restaurant/${id}/${slug}?aid=${aid}`;

const SHARED = 111; // in the listing (both areas) AND in a menu
const JULY_22 = new Date('2026-07-22T08:11:56.249Z');
const JULY_01 = new Date('2026-07-01T00:00:00.000Z');
const SEPT_14 = new Date('2026-09-14T05:00:00.000Z');

function envelope(id: number, createdAt: Date, rest: Record<string, unknown>) {
  return {
    _id: oid(id),
    domain: 'talabat',
    statusCode: 200,
    createdAt,
    ...rest,
  };
}

const areas = [
  { location_id: 1468, location_name: 'Al Zaab', location_slug: 'al-zaab' },
  { location_id: 1461, location_name: 'Al Rowdah', location_slug: 'al-rowdah' },
  {
    location_id: 1594,
    location_name: 'Al  Muntazah',
    location_slug: 'al-muntazah',
  },
];

function listingPage(
  id: number,
  areaId: number,
  slug: string,
  results: unknown[],
) {
  return envelope(id, SEPT_14, {
    params: {
      domain: 'talabat',
      areaSlug: slug,
      areaId: String(areaId),
      page_no: 0,
    },
    payload: { 'Total Page': 1, results },
  });
}

function menu(
  id: number,
  createdAt: Date,
  restaurantId: number,
  name: string,
  category: unknown[],
) {
  return envelope(id, createdAt, {
    params: { restaurant_url: url(restaurantId, 'burger-hub', 1280) },
    payload: {
      results: [
        {
          id: restaurantId + 90000,
          name,
          logo: 'https://images.deliveryhero.io/logo.jpg',
          latitude: '25.1791',
          longitude: '55.2416',
          rate: 4.5,
          totalReviews: 0,
          totalRatings: 100,
          deliveryFee: '6.5',
          DeliveryTime: '25-40 mins',
          'Minimum Order': 20,
          'Restaurant Address': 'Business Bay',
          City: 'Dubai',
          Contact: '00000-00000',
          outletCode: restaurantId,
          category,
        },
      ],
    },
  });
}

const item = (
  item_id: number,
  price: unknown,
  item_name = `Item ${item_id}`,
) => ({
  item_id,
  item_name,
  description: '',
  price,
  rating: 0,
  image: null,
});

const fixture = {
  [LOCATIONS]: [
    envelope(1, JULY_22, { payload: { results: areas } }),
    envelope(2, SEPT_14, { payload: { results: areas } }), // identical snapshot
  ],
  [RESTAURANTS]: [
    listingPage(11, 1468, 'al-zaab', [
      {
        area_name: 'Al Zaab',
        restaurant_name: 'BURGER HUB',
        restaurant_url: url(SHARED, 'burger-hub', 1468),
      },
      {
        area_name: 'Al Zaab',
        restaurant_name: 'Taco Spot',
        restaurant_url: url(222, 'taco-spot', 1468),
      },
    ]),
    listingPage(12, 1461, 'al-rowdah', [
      {
        area_name: 'Al Rowdah',
        restaurant_name: 'BURGER HUB',
        restaurant_url: url(SHARED, 'burger-hub', 1461),
      },
    ]),
    envelope(13, SEPT_14, {
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
  ],
  [MENUS]: [
    menu(21, JULY_22, SHARED, 'Burger Hub', [
      {
        category_id: 7,
        category_name: 'Picks for you 🔥',
        items: [item(9001, 35)],
      },
      {
        category_id: 8,
        category_name: 'Burgers',
        items: [item(9001, 35), item(9002, '29.5'), item(9003, 'free')],
      },
    ]),
    envelope(22, JULY_22, {
      params: { restaurant_url: url(444, 'not-a-page', 1280) },
      payload: { Message: 'This is not restaurant page (Talabat).' },
    }),
    menu(23, JULY_22, 333, 'Falafel House', [
      { category_id: 9, category_name: 'Wraps', items: [item(9101, 12)] },
    ]),
  ],
};

const RAW_DOC_COUNT = 8;

describe('pipeline (integration)', () => {
  let mongod: MongoMemoryServer;
  let moduleRef: TestingModule;
  let raw: Connection;
  let target: Connection;
  let runs: RunRepository;
  let dispatcher: DispatcherService;
  let batches: BatchService;
  const enqueued: BatchJob[] = [];

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(`${uri}provider_raw`, {
          connectionName: RAW_CONNECTION,
        }),
        MongooseModule.forRoot(`${uri}provider_target`, {
          connectionName: TARGET_CONNECTION,
        }),
      ],
      providers: [
        { provide: RAW_SOURCE_READER, useClass: MongoRawSourceReader },
        { provide: TARGET_WRITER, useClass: MongoTargetWriter },
        { provide: RUN_REPOSITORY, useClass: MongoRunRepository },
        { provide: QUARANTINE_REPOSITORY, useClass: MongoQuarantineRepository },
        { provide: PROVIDER_ADAPTERS, useValue: [xbyteAdapter] },
        ProviderRegistry,
        DispatcherService,
        BatchService,
        { provide: ConfigService, useValue: { get: () => BATCH_SIZE } },
        {
          provide: getQueueToken(FACTORY_QUEUE),
          useValue: {
            add: async (_name: string, job: BatchJob) => enqueued.push(job),
          },
        },
      ],
    }).compile();
    await moduleRef.init(); // creates target indexes

    raw = moduleRef.get(getConnectionToken(RAW_CONNECTION));
    target = moduleRef.get(getConnectionToken(TARGET_CONNECTION));
    runs = moduleRef.get(RUN_REPOSITORY);
    dispatcher = moduleRef.get(DispatcherService);
    batches = moduleRef.get(BatchService);

    for (const [collection, docs] of Object.entries(fixture)) {
      await raw.db.collection(collection).insertMany(docs);
    }
  });

  afterAll(async () => {
    await moduleRef?.close();
    await mongod?.stop();
  });

  beforeEach(async () => {
    // Fresh target state per test; indexes must exist for the upsert guard.
    for (const name of [
      'areas',
      'restaurants',
      'menu_items',
      'quarantine',
      'runs',
    ]) {
      await target.db.collection(name).deleteMany({});
    }
  });

  // Creates a run and dispatches it; returns the jobs the dispatcher enqueued.
  async function dispatch(): Promise<{ runId: string; jobs: BatchJob[] }> {
    const run = await runs.create('xbyte');
    enqueued.length = 0;
    await dispatcher.dispatch(run.id);
    return { runId: run.id, jobs: [...enqueued] };
  }

  async function runPipeline(): Promise<Run> {
    const { runId, jobs } = await dispatch();
    for (const job of jobs) await batches.process(job, batchJobId(job));
    return runs.findById(runId);
  }

  // Target documents without _id (the only non-deterministic field).
  async function targetState() {
    const read = (name: string) =>
      target.db
        .collection(name)
        .find({}, { projection: { _id: 0 } })
        .sort({ restaurantExternalId: 1, externalId: 1 })
        .toArray();
    return {
      areas: await read('areas'),
      restaurants: await read('restaurants'),
      menuItems: await read('menu_items'),
    };
  }

  const restaurant = (externalId: number) =>
    target.db.collection('restaurants').findOne({ externalId });
  const menuItem = (externalId: number) =>
    target.db.collection('menu_items').findOne({ externalId });

  it('runs the full pipeline and merges listing + menu into one restaurant', async () => {
    const run = await runPipeline();

    expect(run.status).toBe('completed');
    expect(run.jobs).toEqual({ total: 5, done: 5, failed: 0 }); // 2 docs per job: 1 + 2 + 2
    expect(run.counters.read).toBe(RAW_DOC_COUNT);
    expect(run.counters.failed).toBe(2); // the empty "Page limit" page is valid

    const state = await targetState();
    expect(state.areas.map((a) => [a.externalId, a.name])).toEqual([
      [1461, 'Al Rowdah'],
      [1468, 'Al Zaab'],
      [1594, 'Al Muntazah'], // whitespace collapsed
    ]);
    expect(state.restaurants.map((r) => r.externalId)).toEqual([
      SHARED,
      222,
      333,
    ]);

    const merged = await restaurant(SHARED);
    expect(merged).toMatchObject({
      name: 'Burger Hub', // derived: menu name wins over listing "BURGER HUB"
      url: 'https://www.talabat.com/uae/restaurant/111/burger-hub', // listing, ?aid= stripped
      platformInternalId: 90111, // menu
      deliveryFee: 6.5,
      deliveryTime: { min: 25, max: 40 },
      sources: {
        listing: {
          name: 'BURGER HUB',
          rawId: oid(12).toHexString(),
          fetchedAt: SEPT_14,
        },
        menu: {
          name: 'Burger Hub',
          rawId: oid(21).toHexString(),
          fetchedAt: JULY_22,
        },
      },
    });
    expect([...merged.areaIds].sort()).toEqual([1461, 1468]);

    // Listing-only restaurant: name falls back to the listing.
    expect(await restaurant(222)).toMatchObject({
      name: 'Taco Spot',
      areaIds: [1468],
    });

    expect(state.menuItems.map((i) => i.externalId)).toEqual([
      9001, 9002, 9101,
    ]);
    expect(await menuItem(9001)).toMatchObject({
      restaurantExternalId: SHARED,
      categoryKeys: ['7:picks for you 🔥', '8:burgers'],
      description: null,
      rating: null,
    });
    expect((await menuItem(9002)).price).toBe(29.5);

    const quarantine = await target.db
      .collection('quarantine')
      .find({ runId: run.id })
      .sort({ rawId: 1, recordIndex: 1 })
      .toArray();
    expect(quarantine.map((q) => [q.rawId, q.stage, q.reason])).toEqual([
      [
        oid(21).toHexString(),
        'normalise',
        expect.stringContaining(
          'price (from price): expected a number, got "free"',
        ),
      ],
      [
        oid(22).toHexString(),
        'validate',
        'payload: soft failure: provider says "This is not restaurant page (Talabat)."',
      ],
    ]);
    expect(run.errorSample.map((e) => e.rawId).sort()).toEqual(
      quarantine.map((q) => q.rawId).sort(),
    );
  });

  it('fails the run when a source collection has no documents', async () => {
    const parked = `${MENUS}-parked`;
    await raw.db.collection(MENUS).rename(parked);
    try {
      const { runId, jobs } = await dispatch();
      const run = await runs.findById(runId);
      expect(jobs).toEqual([]); // nothing enqueued
      expect(run.status).toBe('failed');
      expect(run.error).toBe(`no source documents found in ${MENUS}`);
    } finally {
      await raw.db.collection(parked).rename(MENUS);
    }
  });

  it('is idempotent: a second run writes nothing and leaves the same documents', async () => {
    const first = await runPipeline();
    const before = await targetState();

    const second = await runPipeline();

    expect(second.status).toBe('completed');
    expect(second.counters).toEqual({
      ...first.counters,
      written: 0,
      skipped: first.counters.transformed,
    });
    expect(await targetState()).toEqual(before);
  });

  it('does not let an older menu snapshot processed later overwrite a newer one', async () => {
    await runPipeline();
    // Larger _id = processed after the July 22 menu, but fetched earlier.
    const stale = menu(99, JULY_01, SHARED, 'Burger Hub (old)', [
      {
        category_id: 7,
        category_name: 'Old',
        items: [item(9001, 1, 'Old Burger')],
      },
    ]);
    await raw.db.collection(MENUS).insertOne(stale);
    try {
      const { jobs } = await dispatch();
      const staleJob = jobs.find((j) => j.untilId === oid(99).toHexString());
      const newerJob = jobs.find(
        (j) => j.collection === MENUS && j.untilId === oid(22).toHexString(),
      );
      expect(staleJob).toBeDefined();
      expect(staleJob).not.toBe(newerJob); // the writer guard decides, not batch dedupe
      for (const job of jobs) await batches.process(job, batchJobId(job));

      expect(await restaurant(SHARED)).toMatchObject({
        name: 'Burger Hub',
        sources: { menu: { rawId: oid(21).toHexString(), fetchedAt: JULY_22 } },
      });
      expect(await menuItem(9001)).toMatchObject({
        name: 'Item 9001',
        price: 35,
        categoryKeys: ['7:picks for you 🔥', '8:burgers'],
      });
    } finally {
      await raw.db.collection(MENUS).deleteOne({ _id: stale._id });
    }
  });

  it('resumes after a crash: retried and remaining batches give the same state as a clean run', async () => {
    await runPipeline();
    const clean = await targetState();
    for (const name of [
      'areas',
      'restaurants',
      'menu_items',
      'quarantine',
      'runs',
    ]) {
      await target.db.collection(name).deleteMany({});
    }

    const { runId, jobs } = await dispatch();
    const crashAt = 3;
    // Batch k writes its documents, then the worker dies before the job is
    // recorded as complete (the window where double counting could happen).
    for (const job of jobs.slice(0, crashAt))
      await batches.process(job, batchJobId(job));
    const crash = jest
      .spyOn(runs, 'completeJob')
      .mockRejectedValueOnce(new Error('worker killed'));
    await expect(
      batches.process(jobs[crashAt], batchJobId(jobs[crashAt])),
    ).rejects.toThrow('worker killed');
    crash.mockRestore();

    expect((await runs.findById(runId)).status).toBe('running');
    for (const job of jobs.slice(crashAt + 1))
      await batches.process(job, batchJobId(job));
    await batches.process(jobs[crashAt], batchJobId(jobs[crashAt])); // BullMQ retry

    const run = await runs.findById(runId);
    expect(run.status).toBe('completed');
    expect(run.jobs).toEqual({
      total: jobs.length,
      done: jobs.length,
      failed: 0,
    });
    expect(run.counters.read).toBe(RAW_DOC_COUNT); // crashed batch counted once
    expect(await targetState()).toEqual(clean);
  });
});
