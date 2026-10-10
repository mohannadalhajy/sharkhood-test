import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Connection, mongo } from 'mongoose';
import { StageCounters, StageName } from '../core/pipeline/stage';
import {
  DispatchCursor,
  JobDelta,
  JobOutcome,
  Run,
  RunCounters,
  RunRepository,
  RunStatus,
} from '../core/ports/run.repository';
import { TARGET_CONNECTION } from '../database/database.constants';

const STAGES: StageName[] = [
  'validate',
  'extract',
  'normalise',
  'map',
  'deduplicate',
  'project',
];
const ERROR_SAMPLE_SIZE = 20;
const COUNTERS: (keyof RunCounters)[] = [
  'read',
  'transformed',
  'written',
  'skipped',
  'failed',
];

interface RunDocument extends Omit<Run, 'id'> {
  _id: string;
  finishedJobIds: string[]; // makes completeJob idempotent per job
}

// Once every dispatched job has finished, a running run becomes completed.
const ALL_JOBS_FINISHED = {
  $and: [
    { $eq: ['$status', 'running'] },
    { $ne: ['$jobs.total', null] },
    { $eq: [{ $add: ['$jobs.done', '$jobs.failed'] }, '$jobs.total'] },
  ],
};
const COMPLETE_IF_FINISHED = {
  $set: {
    status: {
      $cond: [
        ALL_JOBS_FINISHED,
        {
          $cond: [
            { $gt: ['$jobs.failed', 0] },
            'completed_with_errors',
            'completed',
          ],
        },
        '$status',
      ],
    },
    finishedAt: { $cond: [ALL_JOBS_FINISHED, '$$NOW', '$finishedAt'] },
  },
};

@Injectable()
export class MongoRunRepository implements RunRepository {
  constructor(
    @InjectConnection(TARGET_CONNECTION)
    private readonly connection: Connection,
  ) {}

  private get runs(): mongo.Collection<RunDocument> {
    return this.connection.db.collection<RunDocument>('runs');
  }

  async create(provider: string): Promise<Run> {
    const doc: RunDocument = {
      _id: randomUUID(),
      provider,
      status: 'queued',
      counters: zeroCounters(),
      stages: zeroStages(),
      jobs: { total: null, done: 0, failed: 0 },
      errorSample: [],
      finishedJobIds: [],
      createdAt: new Date(),
    };
    await this.runs.insertOne(doc);
    return toRun(doc);
  }

  async findById(id: string): Promise<Run | null> {
    const doc = await this.runs.findOne(
      { _id: id },
      { projection: { finishedJobIds: 0 } },
    );
    return doc ? toRun(doc) : null;
  }

  async setStatus(
    id: string,
    status: RunStatus,
    error?: string,
  ): Promise<void> {
    const terminal = status === 'completed' || status === 'failed';
    await this.runs.updateOne({ _id: id }, [
      {
        $set: {
          status: { $literal: status },
          startedAt:
            status === 'running'
              ? { $ifNull: ['$startedAt', '$$NOW'] }
              : '$startedAt',
          finishedAt: terminal ? '$$NOW' : '$finishedAt',
          ...(error !== undefined ? { error: { $literal: error } } : {}),
        },
      },
    ]);
  }

  async saveDispatchCursor(id: string, cursor: DispatchCursor): Promise<void> {
    await this.runs.updateOne(
      { _id: id },
      { $set: { dispatchCursor: cursor } },
    );
  }

  async setJobsTotal(id: string, total: number): Promise<void> {
    await this.runs.updateOne({ _id: id }, [
      { $set: { 'jobs.total': total } },
      COMPLETE_IF_FINISHED,
    ]);
  }

  async completeJob(
    id: string,
    jobId: string,
    outcome: JobOutcome,
    delta?: JobDelta,
  ): Promise<void> {
    const increments: Record<string, number> = {
      [`jobs.${outcome}`]: 1,
    };
    for (const name of COUNTERS) {
      increments[`counters.${name}`] = delta?.counters?.[name] ?? 0;
    }
    for (const stage of STAGES) {
      for (const key of ['in', 'out', 'failed'] as const) {
        increments[`stages.${stage}.${key}`] = delta?.stages?.[stage][key] ?? 0;
      }
    }
    // The filter skips a job that was already counted (retry after a crash
    // between this update and BullMQ marking the job complete).
    await this.runs.updateOne({ _id: id, finishedJobIds: { $ne: jobId } }, [
      {
        $set: {
          ...Object.fromEntries(
            Object.entries(increments).map(([path, n]) => [
              path,
              { $add: [`$${path}`, n] },
            ]),
          ),
          finishedJobIds: { $concatArrays: ['$finishedJobIds', [jobId]] },
          // Keep only the first ERROR_SAMPLE_SIZE failures of the run.
          errorSample: {
            $slice: [
              {
                $concatArrays: [
                  { $ifNull: ['$errorSample', []] },
                  {
                    $literal: (delta?.errors ?? []).slice(0, ERROR_SAMPLE_SIZE),
                  },
                ],
              },
              ERROR_SAMPLE_SIZE,
            ],
          },
        },
      },
      COMPLETE_IF_FINISHED,
    ]);
  }
}

function toRun(doc: RunDocument): Run {
  return {
    id: doc._id,
    provider: doc.provider,
    status: doc.status,
    counters: doc.counters,
    stages: doc.stages,
    jobs: doc.jobs,
    dispatchCursor: doc.dispatchCursor,
    createdAt: doc.createdAt,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    error: doc.error,
    errorSample: doc.errorSample ?? [],
  };
}

function zeroCounters(): RunCounters {
  return { read: 0, transformed: 0, written: 0, skipped: 0, failed: 0 };
}

function zeroStages(): StageCounters {
  return Object.fromEntries(
    STAGES.map((s) => [s, { in: 0, out: 0, failed: 0 }]),
  ) as StageCounters;
}
