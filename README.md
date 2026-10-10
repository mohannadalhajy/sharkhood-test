# Provider Data Factory

A NestJS service that reads raw provider dumps from MongoDB (`provider_raw`, read-only), runs them through a deterministic pipeline, and writes a clean, indexed domain model to `provider_target`. BullMQ (Redis) orchestrates the work.
The core is provider-agnostic. The sample provider (`xbyte`, platform `talabat`) is one adapter plus a declarative mapping.

Design and data analysis: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Evidence for every number: [docs/profile.md](docs/profile.md), [docs/verify.md](docs/verify.md).

## Quick start

Requires Docker and Node 20+.

```bash
npm ci

# Mongo, Redis and the app (API on :3000). Mongo is published on host port 27018
# so it cannot clash with a local mongod on 27017.
MONGO_HOST_PORT=27018 docker compose up -d --build

# Load the three sample files from data/ into provider_raw (drops and recreates them).
MONGO_RAW_URI=mongodb://localhost:27018/provider_raw npm run seed

# Trigger a run -> {"runId":"..."}
npm run run:factory

# Status, counters, per-stage counters, jobs, timings
curl -s localhost:3000/runs/<runId>

# Quarantined documents, paginated
curl -s "localhost:3000/runs/<runId>/errors?offset=0&limit=20"
```

Also available: `GET /health` (Mongo raw + target, Redis) and Swagger at `/docs`.
`POST /runs` accepts an optional body `{"provider": "xbyte"}`.

To run the app on the host instead: `cp .env.example .env` (it uses Mongo on 27018, like the commands above), `docker compose up -d mongo redis`, then `npm run start:dev`.

Run statuses:
- `queued` → `running`, then one of:
  - `completed`;
  - `completed_with_errors` (some jobs failed permanently and went to the DLQ);
  - `failed` (the dispatch failed, or a source collection has no documents).

`GET /runs/:id` also returns `errorSample`: the first 20 failure reasons.

## Tests

```bash
npm test           # unit: pipeline runner, field mapping, xbyte transforms and adapter
npm run test:e2e   # integration: full pipeline on mongodb-memory-server (no Redis needed)
```

The integration test covers:
- a restaurant merged from the listing and a menu;
- idempotency;
- the conflict rule (an older snapshot processed later);
- crash recovery: the final state equals a clean run.

The first `test:e2e` downloads a MongoDB 7.0 binary (~150 MB). The version is pinned in `package.json` because the default 8.x binary needs macOS 14+.

## Configuration

Validated with Zod at startup (`src/config/env.schema.ts`). **An invalid or missing value stops the app at boot** with a message naming the variable; it never fails halfway through a run.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |
| `PORT` | `3000` | HTTP port |
| `MONGO_RAW_URI` | required | raw DB (read-only) |
| `MONGO_TARGET_URI` | required | target DB (domain collections, runs, quarantine) |
| `REDIS_HOST` / `REDIS_PORT` | required | BullMQ connection |
| `BATCH_SIZE` | required | documents per job (range size) and cursor batch size |
| `WORKER_CONCURRENCY` | required | concurrent jobs per worker process |
| `MONGO_HOST_PORT` | `27017` | docker compose only: host port for Mongo |
| `LOG_LEVEL` | `debug` / `info` in prod | not validated (read by the logger config) |

## Results on the sample

| | |
| --- | --- |
| Raw documents read | 578 (8 locations, 70 listing pages, 500 menus) |
| `areas` | 697 (8 identical snapshots deduplicated) |
| `restaurants` | 647 (302 from the listing + 345 from menus; the sample has no overlap) |
| `menu_items` | 28,773 (2,329 promo repeats merged into `categoryKeys`) |
| Quarantined | 156 = 155 menu soft failures ("This is not restaurant page") + 1 listing page with only `error: ""` (the "Page limit exceeded" page has `results: []`: a valid empty page) |
| Idempotency | 1st run: written 30,117 · 2nd run: written 0, skipped 30,117, target documents identical |

## Adding a provider

1. Create `src/providers/<name>/`:
   - `<name>.schemas.ts`: Zod schemas for each raw collection's envelope;
   - `<name>.mapping.ts`: declarative field mappings;
   - `<name>.transforms.ts`: provider-specific value transforms;
   - `<name>.adapter.ts`: a `ProviderAdapter` listing its sources and, per source, what it extracts, its natural key and its merge options.
2. Register it in `src/providers/providers.module.ts`.
3. Trigger it with `POST /runs {"provider": "<name>"}`.

Nothing in `src/core` changes. The one exception outside core: a **new entity type** (not area / restaurant / menu item) needs its collection and indexes added in `src/domain/target-collections.ts`.

## Key decisions

Details and reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Natural keys:**
  - restaurants: `{provider, platform, externalId}`, where `externalId` is the id parsed from the URL (= `outletCode`);
  - items: `{…, restaurantExternalId, externalId}`.

  Every write is an upsert on these keys.
- **Per-source freshness:** a restaurant has `sources.listing` and `sources.menu`. Each write is guarded only by its own source's `fetchedAt` (tie → larger raw `_id`). `name` (menu, else listing) and `url` (listing, else menu) are derived from the per-source values. `areaIds` is an unguarded set union: its **membership** doesn't depend on processing order, but the array **order** does (it's insertion order), so read it as a set.
- **E11000 retry:** a guarded upsert that hits a duplicate key is retried once; a second E11000 means the stored data is newer → counted as `skipped`.
- **Range jobs with deterministic ids:**
  - each job is `(afterId, untilId]` of one collection, with id `runId:collection:batchNo`;
  - completion is one atomic, at-most-once-per-job update on the run, so retries never double count.
- **Pure pipeline:** validate → extract → normalise → map → deduplicate → project has no I/O. Bad documents go to quarantine; only infrastructure errors throw and retry.

## Known gaps

- **Items removed from a menu are never deleted.** Upserts don't remove stale rows.
- **Queue tests use an in-memory job collector, not Redis.** The integration test runs the real dispatcher and batch processor, but no test covers BullMQ's own retries, backoff or the move to `factory-batches-dlq`.
- **DLQ and run bookkeeping are not reconciled.** Adding to the DLQ (Redis) and recording `jobs.failed` (Mongo) are two separate writes. If one fails, nothing repairs it later; the handler only logs. Next step: an outbox, or a reconciler that compares the DLQ with the runs.
- **Killed jobs recover slowly.** A job killed mid-run comes back only after BullMQ's stall detection (≈30 s).
- **The listing ↔ menu merge is shown only by the integration fixture.** The sample has no restaurant in both.
- **The `runs` doc keeps one id per finished job** (`finishedJobIds`). That's fine up to roughly 100k jobs per run; beyond that it should move to its own collection.
- **`transformed` depends on `BATCH_SIZE`,** because dedupe works per batch. The target state does not.
- **Counters under retries reflect only the successful attempt.** A failed attempt's partial work (e.g. writes before a crash) isn't counted, and its re-run sees those rows as `skipped`. So `written` can undercount and `skipped` overcount after retries; the target data is still correct.
- **`POST /runs` has no filters or limits.**
- **A genuine item rating of 0 can't be told apart from "unrated".**
- **No full target-entity schemas.** Values are checked field by field (types, ranges such as price ≥ 0 and rating 0..5), but no schema validates a whole area, restaurant or item before it's written. Next step: a Zod schema per target entity, checked in `project`.
- **API and worker run in one process.** They can't be scaled separately. Next step: a `ROLE=api|worker` switch that decides which modules load.
- **Seeding needs Node on the host** (`npm ci`, then `npm run seed`); `docker compose up` alone doesn't load the data.

## With another week

- `lastSeenAt` per item (or a soft delete) to handle items removed from a menu.
- A metrics endpoint (Prometheus): jobs, throughput, quarantine rate, retry and DLQ counts.
- Structured JSON logs everywhere. Today, worker and dispatcher lines carry `runId` / `jobId` / `collection`, and logs are JSON in production and in `logs/*.log`; there is no HTTP request logging yet.
- A load test at 1000× the sample, to tune `BATCH_SIZE`, concurrency and bulk-write sizes.
- A provider registry driven by config instead of a code list.
