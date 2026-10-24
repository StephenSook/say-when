// The structured output the planner asks Claude for. One fixed schema for every request, so the API compiles it
// once and caches it (a schema that changed per request would pay the compile cost every time). Rules a JSON
// schema cannot say (distinct tones, known source ids, allowed forms) are checked in validate.ts.

import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The same zod entry the SDK helper uses, so the schema types line up.
import { z } from 'zod/v4';

import { TONES } from '../types.js';

export const PlanReplySchema = z.object({
    answer_mode: z.enum(['pick', 'yes_no']),
    options: z.array(
        z.object({
            text: z.string(),
            kind: z.enum(['reply', 'errand', 'call']),
            tone: z.enum(TONES),
            laugh: z.boolean(),
            sources: z.array(z.string()),
            errand: z
                .object({
                    form_key: z.string(),
                    fields: z.array(z.object({ label: z.string(), value: z.string() })),
                })
                .nullable(),
            call: z.object({ contact_id: z.string() }).nullable(),
        }),
    ),
});

export type PlanReply = z.infer<typeof PlanReplySchema>;

/** The output format for `output_config.format`, with a `parse` that runs the zod check on the reply text. */
export const planReplyFormat = zodOutputFormat(PlanReplySchema);
