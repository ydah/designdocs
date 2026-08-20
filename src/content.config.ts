import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { normalizeTag } from './lib/tags.mjs';

const STATUS = ['draft', 'proposed', 'accepted', 'rejected', 'superseded'] as const;

const normalizedTag = z.string().transform(normalizeTag).refine(Boolean, {
  message: 'タグは空にできません',
});

const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    status: z.enum(STATUS).default('draft'),
    tags: z.array(normalizedTag).default([]),
    authors: z.array(z.string()).default([]),
    created: z.coerce.date().optional(),
    updated: z.coerce.date().optional(),
    decided: z.coerce.date().optional(),
    superseded_by: z.string().min(1).optional(),
    related: z.array(z.string().min(1)).default([]),
  }),
});

export { STATUS };
export const collections = { docs };
