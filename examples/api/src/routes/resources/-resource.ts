import { z } from 'zod';

/**
 * Colocation: the leading `-` keeps this file out of the route tree, so the
 * schemas, type, and fixtures that only `index.ts` and `$id.ts` use sit beside
 * them instead of in a directory away from the endpoints they belong to.
 */

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

// Fixtures rather than a database: enough for the endpoints to agree with one
// another — an unknown id is a 404 in every method that takes one — without the
// showcase growing a dependency or state that outlives a request.
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
