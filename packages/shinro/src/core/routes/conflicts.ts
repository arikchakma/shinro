import { relative, sep } from 'node:path';

import { toProjectPath } from '../path.ts';
import type { Route } from './discover.ts';
import { isGroupSegment } from './url.ts';

const GROUP_SEGMENT_HINT =
  'A "(group)" directory contributes middleware only, so it adds no URL segment.';

type Conflict = {
  files: Set<string>;
  headline: string;
  notes: string[];
};

/** Throws when two route files would serve the same URL. */
export function validateRoutes(
  routes: Route[],
  root: string,
  routesDirectory: string
): void {
  // Each route's shape is derived once. Computing it inside the pairwise scan
  // ran two regex replacements per comparison, which grows quadratically with
  // the route count.
  const shapes = routes.map((route) => routeShape(route.path));
  const hasSubRouter = routes.some((route) => route.kind === 'sub-router');
  // Collected rather than thrown on sight. Conflicts arrive in batches — a
  // rename that lands `users.ts` next to `users/index.ts` usually did the same
  // to `$id.ts` — and fixing them one round-trip at a time is the slow way to
  // find that out. Keyed by the conflicting path so three files on one URL are
  // one entry with three files, not three pairs.
  const conflicts = new Map<string, Conflict>();

  const record = (headline: string, files: string[], notes: string[]): void => {
    const existing = conflicts.get(headline);

    if (existing === undefined) {
      conflicts.set(headline, { files: new Set(files), headline, notes });
      return;
    }

    for (const file of files) {
      existing.files.add(file);
    }

    // The group hint rides on whichever pair happened to involve the grouped
    // file, which is not always the first pair for this path. Merging keeps the
    // explanation attached to the conflict it explains.
    for (const note of notes) {
      if (!existing.notes.includes(note)) {
        existing.notes.push(note);
      }
    }
  };

  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < routes.length;
      rightIndex += 1
    ) {
      const right = routes[rightIndex];
      const sameShape = shapes[leftIndex] === shapes[rightIndex];
      const subRouterOverlap =
        hasSubRouter &&
        (reservesPath(left, right.path) || reservesPath(right, left.path));

      if (!sameShape && !subRouterOverlap) {
        continue;
      }

      // Two files at different depths collapsing onto one URL reads as a
      // contradiction unless the message says why, so a group in either path
      // explains itself here.
      const groupHint =
        isInGroupDirectory(routesDirectory, left.file) ||
        isInGroupDirectory(routesDirectory, right.file)
          ? [GROUP_SEGMENT_HINT]
          : [];

      if (subRouterOverlap) {
        const owner = reservesPath(left, right.path) ? left : right;
        const descendant = owner === left ? right : left;

        record(
          `Route namespace conflict at ${JSON.stringify(owner.path)}:`,
          [
            toProjectPath(root, owner.file),
            toProjectPath(root, descendant.file),
          ],
          [
            `The default sub-router at ${owner.path} owns its complete mount namespace.`,
            ...groupHint,
          ]
        );
        continue;
      }

      record(
        `Route conflict at ${JSON.stringify(sameShape ? left.path : `${left.path} ↔ ${right.path}`)}:`,
        [toProjectPath(root, left.file), toProjectPath(root, right.file)],
        groupHint
      );
    }
  }

  if (conflicts.size === 0) {
    return;
  }

  // One error carrying every conflict, blocks separated by a blank line. The
  // `[shinro]` prefix leads only the first: the message is one diagnostic, and
  // repeating the prefix per block would read as several.
  throw new Error(
    [...conflicts.values()]
      .map((conflict, index) =>
        [
          `${index === 0 ? '[shinro] ' : ''}${conflict.headline}`,
          ...[...conflict.files].map((file) => `- ${file}`),
          ...conflict.notes,
        ].join('\n')
      )
      .join('\n\n')
  );
}

/**
 * Whether a sub-router's mount namespace covers `path`. A dynamic segment on
 * either side matches anything, so `/users/:id` and `/users/settings` both fall
 * inside a sub-router mounted at `/users/:id`.
 */
function reservesPath(route: Route, path: string): boolean {
  if (route.kind !== 'sub-router') {
    return false;
  }

  const ownerSegments = route.path.split('/').filter(Boolean);
  const candidateSegments = path.split('/').filter(Boolean);
  if (ownerSegments.length === 0) {
    return true;
  }

  for (let index = 0; index < ownerSegments.length; index += 1) {
    const owner = ownerSegments[index];
    const candidate = candidateSegments[index];
    if (candidate === undefined) {
      return false;
    }
    if (isCatchAllSegment(owner) || isCatchAllSegment(candidate)) {
      return true;
    }
    if (
      !isDynamicSegment(owner) &&
      !isDynamicSegment(candidate) &&
      owner !== candidate
    ) {
      return false;
    }
  }

  return true;
}

/** A path with its parameter names erased, so `/$id` and `/$slug` compare equal. */
function routeShape(path: string): string {
  return path
    .replace(/:[^/{}]+\{\.\+\}/g, '$catch-all')
    .replace(/:[^/{}]+/g, '$dynamic');
}

function isInGroupDirectory(routesDirectory: string, file: string): boolean {
  return relative(routesDirectory, file)
    .split(sep)
    .slice(0, -1)
    .some(isGroupSegment);
}

function isCatchAllSegment(segment: string): boolean {
  return segment.startsWith(':') && segment.endsWith('{.+}');
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(':');
}
