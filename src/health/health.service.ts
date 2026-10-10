import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Connection } from 'mongoose';
import {
  RAW_CONNECTION,
  TARGET_CONNECTION,
} from '../database/database.constants';
import { INGEST_QUEUE } from '../queue/queue.constants';

export type DependencyStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  dependencies: Record<'mongoRaw' | 'mongoTarget' | 'redis', DependencyStatus>;
}

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  constructor(
    @InjectConnection(RAW_CONNECTION) private readonly raw: Connection,
    @InjectConnection(TARGET_CONNECTION) private readonly target: Connection,
    @InjectQueue(INGEST_QUEUE) private readonly queue: Queue,
  ) {}

  async check(): Promise<HealthReport> {
    const [mongoRaw, mongoTarget, redis] = await Promise.all([
      probe(() => this.raw.db.admin().ping()),
      probe(() => this.target.db.admin().ping()),
      // BullMQ's client interface has no ping(); INFO is an equivalent round trip.
      probe(async () => (await this.queue.client).info()),
    ]);
    const dependencies = { mongoRaw, mongoTarget, redis };
    const allUp = Object.values(dependencies).every((s) => s === 'up');
    return { status: allUp ? 'ok' : 'error', dependencies };
  }
}

// A dead dependency can make a ping hang (ioredis queues commands while
// reconnecting), so every probe is bounded by a timeout.
async function probe(fn: () => Promise<unknown>): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
