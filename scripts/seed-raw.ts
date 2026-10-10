import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { BSON, Db, Document, MongoClient } from 'mongodb';
import { envSchema } from '../src/config/env.schema';

const DATA_DIR = join(__dirname, '..', 'data');
const SUPPORTED_EXTENSIONS = new Set(['.json', '.ndjson', '.jsonl']);
const INSERT_BATCH_SIZE = 1000;

async function main(): Promise<void> {
  const { MONGO_RAW_URI } = envSchema
    .pick({ MONGO_RAW_URI: true })
    .parse(process.env);

  const client = await MongoClient.connect(MONGO_RAW_URI);
  try {
    // Database name comes from the URI path (e.g. /provider_raw).
    const db = client.db();
    const files = (await readdir(DATA_DIR))
      .filter((file) => SUPPORTED_EXTENSIONS.has(extname(file)))
      .sort();

    for (const file of files) {
      const collection = basename(file, extname(file));
      const count = await seedCollection(db, join(DATA_DIR, file), collection);
      console.log(`${db.databaseName}.${collection} <- ${file}: ${count} docs`);
    }
  } finally {
    await client.close();
  }
}

// Drop + recreate so re-running the seed always yields the same state.
async function seedCollection(
  db: Db,
  path: string,
  name: string,
): Promise<number> {
  if (await db.listCollections({ name }).hasNext()) {
    await db.collection(name).drop();
  }
  const collection = await db.createCollection(name);

  let batch: Document[] = [];
  let count = 0;
  for await (const doc of readDocuments(path)) {
    batch.push(doc);
    if (batch.length === INSERT_BATCH_SIZE) {
      await collection.insertMany(batch);
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await collection.insertMany(batch);
    count += batch.length;
  }
  return count;
}

// Files are MongoDB Extended JSON ({"$oid": ...}, {"$date": ...}). EJSON in
// canonical mode restores the original BSON types instead of plain objects.
async function* readDocuments(path: string): AsyncGenerator<Document> {
  if (await isJsonArray(path)) {
    yield* BSON.EJSON.parse(await readFile(path, 'utf8'), { relaxed: false });
    return;
  }
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim()) {
      yield BSON.EJSON.parse(line, { relaxed: false }) as Document;
    }
  }
}

// Sniff content rather than trusting the extension: mongoexport writes
// NDJSON to .json files unless --jsonArray is passed.
async function isJsonArray(path: string): Promise<boolean> {
  const handle = await open(path);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
    return buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .trimStart()
      .startsWith('[');
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
