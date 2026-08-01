import { z } from 'zod';

/** The leading `-` keeps this file out of the route tree, so what only
 * `index.ts` and `$id.ts` use can sit beside them. */

export type Resource = {
  id: string;
  name: string;
};

/** The collection's query string. */
export const resourceQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().optional(),
});

/** The parameter `$id.ts` declares in its filename. */
export const resourceParams = z.object({
  id: z.string().min(3),
});

/** The body both POST and PATCH accept. */
export const resourceInput = z.object({
  name: z.string().trim().min(1),
});

// Fixtures rather than a database, so the showcase carries no state.
const RESOURCES: Resource[] = [
  { id: 'res_123', name: 'Example resource' },
  { id: 'res_456', name: 'Another resource' },
];

export function listResources(limit: number): Resource[] {
  return RESOURCES.slice(0, limit);
}

export function findResource(id: string): Resource | undefined {
  return RESOURCES.find((resource) => resource.id === id);
}
