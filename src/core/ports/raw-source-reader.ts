export interface RawDocument {
  id: string; // _id as a string, so core stays driver-agnostic
  body: Record<string, unknown>;
}

export interface ReadOptions {
  batchSize: number;
  afterId?: string; // exclusive; resume point (last processed id)
  untilId?: string; // inclusive; lets a job own a fixed _id range
}

// Read-only. Batches come in ascending _id order, so the last id of a
// processed batch is a valid checkpoint.
export interface RawSourceReader {
  read(collection: string, options: ReadOptions): AsyncIterable<RawDocument[]>;
}
