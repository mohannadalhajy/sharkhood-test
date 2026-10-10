import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ProviderRegistry } from '../providers/provider-registry';
import { RunsService } from './runs.service';

const createRunSchema = z.object({ provider: z.string().default('xbyte') });

const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success)
    throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

@ApiTags('runs')
@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly providers: ProviderRegistry,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Create a run and dispatch it' })
  async create(@Body() body: unknown) {
    const { provider } = parse(createRunSchema, body);
    if (!this.providers.has(provider)) {
      throw new BadRequestException(`Unknown provider "${provider}"`);
    }
    return this.runs.start(provider);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Status, counters, stage counters, jobs and timings',
  })
  async findOne(@Param('id') id: string) {
    const run = await this.runs.findRun(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    const { createdAt, startedAt, finishedAt } = run;
    return {
      id: run.id,
      provider: run.provider,
      status: run.status,
      error: run.error,
      counters: run.counters,
      stages: run.stages,
      jobs: run.jobs,
      errorSample: run.errorSample,
      timings: {
        createdAt,
        startedAt,
        finishedAt,
        durationMs:
          startedAt && finishedAt
            ? finishedAt.getTime() - startedAt.getTime()
            : undefined,
      },
    };
  }

  @Get(':id/errors')
  @ApiOperation({ summary: 'Paginated quarantine of a run' })
  async errors(@Param('id') id: string, @Query() query: unknown) {
    if (!(await this.runs.findRun(id)))
      throw new NotFoundException(`Run ${id} not found`);
    const page = parse(pageSchema, query);
    return { ...page, ...(await this.runs.findErrors(id, page)) };
  }
}
