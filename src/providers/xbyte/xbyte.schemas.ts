import { z } from 'zod';

// Boundary schemas for the three raw collections. They check envelope
// structure and known provider failures; field values are checked later by
// the mapping transforms, so one bad record does not reject its siblings.

export const PLATFORM = 'talabat';

const record = z.record(z.string(), z.unknown());

const envelope = {
  domain: z.literal(PLATFORM),
  statusCode: z.literal(200),
  createdAt: z.date(), // used as fetchedAt (request_time has no timezone)
};

export const locationsSchema = z.object({
  ...envelope,
  payload: z.object({ results: z.array(record) }),
});

export const restaurantsSchema = z.object({
  ...envelope,
  params: z.object({ areaId: z.string() }),
  payload: z
    .object({
      'Page Error Message': z.string().optional(),
      error: z.string().optional(),
      results: z.array(record).optional(),
    })
    .superRefine((payload, ctx) => {
      if (payload['Page Error Message'] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `provider error: "${payload['Page Error Message']}"`,
        });
      } else if (payload.error !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `provider error: error field = ${JSON.stringify(payload.error)}, no results`,
        });
      } else if (!payload.results) {
        ctx.addIssue({ code: 'custom', message: 'results is missing' });
      }
    }),
});

const menuCategory = z.object({
  category_id: z.number().int(),
  category_name: z.string(),
  items: z.array(record),
});

export const menusSchema = z.object({
  ...envelope,
  params: z.object({ restaurant_url: z.string() }),
  payload: z
    .object({
      Message: z.string().optional(),
      results: z
        .array(z.looseObject({ category: z.array(menuCategory) }))
        .optional(),
    })
    .superRefine((payload, ctx) => {
      if (!payload.results) {
        // statusCode is 200 here: the provider reports failures in Message.
        ctx.addIssue({
          code: 'custom',
          message: payload.Message
            ? `soft failure: provider says "${payload.Message}"`
            : 'results is missing',
        });
      } else if (payload.results.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: `expected exactly 1 result, got ${payload.results.length}`,
        });
      }
    }),
});

export type LocationsEnvelope = z.infer<typeof locationsSchema>;
export type RestaurantsEnvelope = z.infer<typeof restaurantsSchema>;
export type MenusEnvelope = z.infer<typeof menusSchema>;
