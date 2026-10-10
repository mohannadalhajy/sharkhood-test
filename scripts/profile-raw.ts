import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, MongoClient } from 'mongodb';
import { envSchema } from '../src/config/env.schema';

// Read-only profiler for the raw DB. Walks every document and writes a
// per-field report to docs/profile.md. Paths use dot notation; `[]` marks
// array items (e.g. payload.results[].location_id).

const OUTPUT_PATH = join(__dirname, '..', 'docs', 'profile.md');
const SAMPLE_LIMIT = 3;
const SAMPLE_MAX_CHARS = 60;
// Stop tracking distinct values past this point to bound memory.
const DISTINCT_LIMIT = 100_000;
// Leaf names that look like identifiers (id, areaId, location_id, slug, url...).
const ID_FIELD_PATTERN = /(id|slug|url|key|code)$/i;
// Relationship report: minimum shared values and minimum coverage of the
// smaller side before a pair of fields is listed.
const REL_MIN_OVERLAP = 1;
const REL_MIN_COVERAGE = 0.2;

interface FieldStats {
  path: string;
  // Object path whose keys include this field ('' = document root);
  // null for array-item paths (`x[]`).
  parent: string | null;
  docs: number; // documents containing the path at least once
  lastDoc: number; // doc index last counted, to count each doc once
  values: number; // total occurrences (can exceed docs inside arrays)
  types: Map<string, number>;
  nulls: number;
  emptyStrings: number;
  numericStrings: number;
  samples: string[];
  // Raw values keyed with their type (so 1280 and "1280" stay distinct).
  rawCounts: Map<string, number>;
  normalizedCounts: Map<string, number>;
  distinctTruncated: boolean;
  array?: {
    count: number;
    empty: number;
    min: number;
    max: number;
    total: number;
  };
}

interface CollectionProfile {
  name: string;
  total: number;
  fields: Map<string, FieldStats>;
  objectCounts: Map<string, number>; // times an object was seen at each path
}

async function main(): Promise<void> {
  const { MONGO_RAW_URI, BATCH_SIZE } = envSchema
    .pick({ MONGO_RAW_URI: true, BATCH_SIZE: true })
    .parse(process.env);

  const client = await MongoClient.connect(MONGO_RAW_URI);
  try {
    const db = client.db();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .sort();

    const profiles: CollectionProfile[] = [];
    for (const name of names) {
      const profile: CollectionProfile = {
        name,
        total: 0,
        fields: new Map(),
        objectCounts: new Map(),
      };
      const cursor = db.collection(name).find({}).batchSize(BATCH_SIZE);
      for await (const doc of cursor) {
        walkObject(profile, doc, '', profile.total);
        profile.total++;
      }
      console.log(
        `${name}: ${profile.total} docs, ${profile.fields.size} paths`,
      );
      profiles.push(profile);
    }

    const markdown = render(db.databaseName, profiles, BATCH_SIZE);
    await writeFile(OUTPUT_PATH, markdown);
    console.log(`Wrote ${OUTPUT_PATH}`);
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

function walkObject(
  profile: CollectionProfile,
  obj: Document,
  path: string,
  docIndex: number,
): void {
  profile.objectCounts.set(path, (profile.objectCounts.get(path) ?? 0) + 1);
  for (const [key, value] of Object.entries(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    walkValue(profile, value, childPath, path, docIndex);
  }
}

function walkValue(
  profile: CollectionProfile,
  value: unknown,
  path: string,
  parent: string | null,
  docIndex: number,
): void {
  const stats = getStats(profile, path, parent);
  if (stats.lastDoc !== docIndex) {
    stats.docs++;
    stats.lastDoc = docIndex;
  }
  stats.values++;

  const type = typeOf(value);
  stats.types.set(type, (stats.types.get(type) ?? 0) + 1);

  if (type === 'array') {
    const items = value as unknown[];
    const a = (stats.array ??= {
      count: 0,
      empty: 0,
      min: Infinity,
      max: 0,
      total: 0,
    });
    a.count++;
    a.total += items.length;
    a.min = Math.min(a.min, items.length);
    a.max = Math.max(a.max, items.length);
    if (items.length === 0) a.empty++;
    for (const item of items) {
      walkValue(profile, item, `${path}[]`, null, docIndex);
    }
    return;
  }
  if (type === 'object') {
    walkObject(profile, value as Document, path, docIndex);
    return;
  }
  recordScalar(stats, type, value);
}

function recordScalar(stats: FieldStats, type: string, value: unknown): void {
  if (type === 'null') {
    stats.nulls++;
    return;
  }
  const text = scalarToString(value);
  if (type === 'string') {
    if (text.trim() === '') stats.emptyStrings++;
    else if (!Number.isNaN(Number(text))) stats.numericStrings++;
  }
  if (stats.samples.length < SAMPLE_LIMIT && !stats.samples.includes(text)) {
    stats.samples.push(text);
  }
  if (stats.distinctTruncated) return;
  increment(stats.rawCounts, `${type}:${text}`);
  increment(stats.normalizedCounts, normalize(text));
  if (stats.rawCounts.size > DISTINCT_LIMIT) {
    stats.distinctTruncated = true;
  }
}

function getStats(
  profile: CollectionProfile,
  path: string,
  parent: string | null,
): FieldStats {
  let stats = profile.fields.get(path);
  if (!stats) {
    stats = {
      path,
      parent,
      docs: 0,
      lastDoc: -1,
      values: 0,
      types: new Map(),
      nulls: 0,
      emptyStrings: 0,
      numericStrings: 0,
      samples: [],
      rawCounts: new Map(),
      normalizedCounts: new Map(),
      distinctTruncated: false,
    };
    profile.fields.set(path, stats);
  }
  return stats;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'object') {
    // BSON wrappers (ObjectId, Long, Decimal128, Binary...) are scalars.
    const bsonType = (value as { _bsontype?: string })._bsontype;
    return bsonType ?? 'object';
  }
  return typeof value; // string, boolean, bigint
}

function scalarToString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(
  dbName: string,
  profiles: CollectionProfile[],
  batchSize: number,
): string {
  const out: string[] = [
    `# Raw data profile: \`${dbName}\``,
    '',
    `Generated by \`scripts/profile-raw.ts\` (cursor batch size ${batchSize}).`,
    '',
    'Path notation: `a.b` = nested field, `a[]` = items of array `a`.',
    '"Missing (docs)" is relative to all documents in the collection;',
    '"Present in parent" is relative to the number of objects at the parent path',
    '(meaningful for fields inside array items).',
    '',
  ];

  for (const p of profiles) {
    out.push(`## ${p.name}`, '', `Total documents: **${p.total}**`, '');
    out.push(...renderFields(p), '');
    out.push(...renderIdCandidates(p), '');
    out.push(...renderArrays(p), '');
  }
  out.push(...renderRelationships(profiles), '');
  return out.join('\n');
}

function renderFields(p: CollectionProfile): string[] {
  const rows = [...p.fields.values()].map((f) => {
    const parentCount =
      f.parent === null ? undefined : p.objectCounts.get(f.parent);
    const inParent =
      parentCount === undefined
        ? '—'
        : `${f.values}/${parentCount} (${pct(f.values, parentCount)})`;
    return [
      code(f.path),
      `${f.docs}/${p.total}`,
      pct(p.total - f.docs, p.total),
      inParent,
      formatTypes(f.types),
      fieldNotes(f).join('<br>'),
      f.samples.map((s) => code(truncate(s))).join('<br>'),
    ];
  });
  return [
    '### Fields',
    '',
    ...table(
      [
        'Path',
        'Docs present',
        'Missing (docs)',
        'Present in parent',
        'Types',
        'Notes',
        'Samples',
      ],
      rows,
    ),
  ];
}

function fieldNotes(f: FieldStats): string[] {
  const notes: string[] = [];
  const nonNullTypes = [...f.types.keys()].filter((t) => t !== 'null');
  if (nonNullTypes.length > 1) notes.push(`⚠ mixed types`);
  if (f.nulls) notes.push(`${f.nulls} null`);
  if (f.emptyStrings) notes.push(`${f.emptyStrings} empty/blank string`);
  if (f.numericStrings) notes.push(`${f.numericStrings} numeric string`);
  return notes;
}

function renderIdCandidates(p: CollectionProfile): string[] {
  const rows = [...p.fields.values()]
    .filter(
      (f) => ID_FIELD_PATTERN.test(leafName(f.path)) && f.rawCounts.size > 0,
    )
    .map((f) => {
      const nonNull = f.values - f.nulls;
      const rawDistinct = f.rawCounts.size;
      const normDistinct = f.normalizedCounts.size;
      return [
        code(f.path),
        String(nonNull),
        String(rawDistinct) + (f.distinctTruncated ? '+' : ''),
        String(countDuplicated(f.rawCounts)),
        String(nonNull - rawDistinct),
        String(normDistinct),
        String(countDuplicated(f.normalizedCounts)),
        String(rawDistinct - normDistinct),
      ];
    });
  if (rows.length === 0) return ['### ID candidates', '', '_None._'];
  return [
    '### ID candidates',
    '',
    'Counts are over non-null values. "Dup values" = distinct values seen more than once;',
    '"Extra occurrences" = values − distinct. "Merged by normalization" = raw distinct',
    'values that collapse together after trim + lowercase (also merges `1280` with `"1280"`).',
    '',
    ...table(
      [
        'Path',
        'Values',
        'Distinct',
        'Dup values',
        'Extra occurrences',
        'Distinct (normalized)',
        'Dup values (normalized)',
        'Merged by normalization',
      ],
      rows,
    ),
  ];
}

function renderArrays(p: CollectionProfile): string[] {
  const rows = [...p.fields.values()]
    .filter((f) => f.array)
    .map((f) => {
      const a = f.array;
      const itemPath = `${f.path}[]`;
      const items = p.fields.get(itemPath);
      const itemKeys = [...p.fields.values()]
        .filter((c) => c.parent === itemPath)
        .map((c) => leafName(c.path));
      return [
        code(f.path),
        String(a.count),
        String(a.empty),
        String(a.min),
        String(a.max),
        (a.total / a.count).toFixed(1),
        items ? formatTypes(items.types) : '—',
        itemKeys.map(code).join(', ') || '—',
      ];
    });
  if (rows.length === 0) return ['### Arrays', '', '_None._'];
  return [
    '### Arrays',
    '',
    ...table(
      [
        'Path',
        'Arrays seen',
        'Empty',
        'Min len',
        'Max len',
        'Avg len',
        'Item types',
        'Item keys',
      ],
      rows,
    ),
  ];
}

// Compares normalized value sets of scalar fields across collections. Only
// ID-like fields and string fields take part: plain numbers (price, page_no)
// overlap by coincidence. Constants (one distinct value, e.g. domain) are noise.
function renderRelationships(profiles: CollectionProfile[]): string[] {
  const candidates = profiles.flatMap((p) =>
    [...p.fields.values()]
      .filter(
        (f) =>
          f.normalizedCounts.size > 1 &&
          (ID_FIELD_PATTERN.test(leafName(f.path)) || f.types.has('string')),
      )
      .map((f) => ({ collection: p.name, field: f })),
  );

  const rows: { overlap: number; cells: string[] }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.collection === b.collection) continue;
      const overlap = countOverlap(
        a.field.normalizedCounts,
        b.field.normalizedCounts,
      );
      const aSize = a.field.normalizedCounts.size;
      const bSize = b.field.normalizedCounts.size;
      if (
        overlap < REL_MIN_OVERLAP ||
        overlap / Math.min(aSize, bSize) < REL_MIN_COVERAGE
      ) {
        continue;
      }
      rows.push({
        overlap,
        cells: [
          `${a.collection}<br>${code(a.field.path)}`,
          `${b.collection}<br>${code(b.field.path)}`,
          String(overlap),
          `${pct(overlap, aSize)} of ${aSize}`,
          `${pct(overlap, bSize)} of ${bSize}`,
          formatTypes(a.field.types) + ' ↔ ' + formatTypes(b.field.types),
        ],
      });
    }
  }
  rows.sort((x, y) => y.overlap - x.overlap);

  const header = [
    '## Possible cross-collection relationships',
    '',
    'Pairs of fields whose normalized (trim + lowercase, type-insensitive) distinct values',
    `overlap by at least ${REL_MIN_OVERLAP} values and at least ${REL_MIN_COVERAGE * 100}% of the smaller set.`,
    'Exact value matches only: IDs embedded inside other strings (e.g. URLs) are not detected.',
    '',
  ];
  if (rows.length === 0) return [...header, '_None found._'];
  return [
    ...header,
    ...table(
      [
        'Field A',
        'Field B',
        'Shared values',
        'Coverage of A',
        'Coverage of B',
        'Types (A ↔ B)',
      ],
      rows.map((r) => r.cells),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countDuplicated(counts: Map<string, number>): number {
  let n = 0;
  for (const c of counts.values()) if (c > 1) n++;
  return n;
}

function countOverlap(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const key of small.keys()) if (large.has(key)) n++;
  return n;
}

function leafName(path: string): string {
  const segments = path.replace(/\[\]/g, '').split('.');
  return segments[segments.length - 1];
}

function formatTypes(types: Map<string, number>): string {
  return [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}: ${n}`)
    .join(', ');
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > SAMPLE_MAX_CHARS
    ? `${oneLine.slice(0, SAMPLE_MAX_CHARS)}…`
    : oneLine;
}

function code(text: string): string {
  return '`' + text.replace(/`/g, "'") + '`';
}

function table(headers: string[], rows: string[][]): string[] {
  const escape = (cell: string) => cell.replace(/\|/g, '\\|');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(escape).join(' | ')} |`),
  ];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
