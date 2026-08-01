import { relative, sep } from 'node:path';

type SegmentPart = {
  escaped: boolean;
  text: string;
};

type ResolvedSegment = {
  escaped: boolean;
  literal: string;
};

export function toRoutePath(
  routesDirectory: string,
  file: string,
  reportedFile: string = file
): string {
  const relativeFile = relative(routesDirectory, file).split(sep).join('/');
  const pathSegments = relativeFile.replace(/\.[^.]+$/, '').split('/');
  const lastIndex = pathSegments.length - 1;
  const segments: ResolvedSegment[] = [];

  for (const [index, segment] of pathSegments.entries()) {
    const parts = splitSegmentEscapes(segment);

    if (parts.some((part) => part.escaped) || !isGroupSegment(segment)) {
      segments.push(resolvePathSegment(reportedFile, parts, segment));
      continue;
    }

    if (index === lastIndex) {
      throw new Error(
        `[shinro] Invalid route ${reportedFile}: ${JSON.stringify(
          segment
        )} names a route group, which only a directory can be. Move the route into a ${JSON.stringify(
          segment
        )} directory, or rename it to ${JSON.stringify(
          `[${segment}]`
        )} to serve ${JSON.stringify(`/${segment}`)} literally.`
      );
    }

    assertGroupName(reportedFile, segment);
  }

  const lastSegment = segments.at(-1);
  if (lastSegment && !lastSegment.escaped && lastSegment.literal === 'index') {
    segments.pop();
  }

  assertFinalCatchAll(reportedFile, segments);
  assertUniqueParameters(reportedFile, segments);

  const path = segments
    .map((segment) =>
      segment.escaped ? segment.literal : toHonoSegment(segment.literal)
    )
    .join('/');
  return path ? `/${path}` : '/';
}

export function isGroupSegment(segment: string): boolean {
  return (
    segment.length >= 2 && segment.startsWith('(') && segment.endsWith(')')
  );
}

/** Splits a filename segment into escaped and unescaped runs. Matching `[` to the
 * *next* `]` makes `[[weird]]` resolve to `[weird]` and leaves an unmatched `[`
 * as an ordinary character, so escaping needs no diagnostic of its own. */
function splitSegmentEscapes(segment: string): SegmentPart[] {
  const parts: SegmentPart[] = [];
  let index = 0;

  while (index < segment.length) {
    const open = segment.indexOf('[', index);
    const close = open === -1 ? -1 : segment.indexOf(']', open + 1);

    if (close === -1) {
      parts.push({ escaped: false, text: segment.slice(index) });
      break;
    }

    if (open > index) {
      parts.push({ escaped: false, text: segment.slice(index, open) });
    }
    parts.push({ escaped: true, text: segment.slice(open + 1, close) });
    index = close + 1;
  }

  return parts;
}

function resolvePathSegment(
  file: string,
  parts: SegmentPart[],
  segment: string
): ResolvedSegment {
  const escaped = parts.some((part) => part.escaped);
  const unescaped = parts
    .filter((part) => !part.escaped)
    .map((part) => part.text)
    .join('');

  if (/[()]/.test(unescaped)) {
    throw new Error(
      `[shinro] Invalid route ${file}: ${JSON.stringify(
        segment
      )} is not a valid route group. Write "(name)" to group routes without adding a URL segment, or ${JSON.stringify(
        `[${segment}]`
      )} to serve the parentheses literally.`
    );
  }

  if (escaped && unescaped.startsWith('$')) {
    throw new Error(
      `[shinro] Invalid route ${file}: dynamic segment ${JSON.stringify(
        segment
      )} cannot contain an escape, because Hono would read the escaped text as part of the parameter name. Escape the whole segment, or drop the escape.`
    );
  }

  const literal = parts.map((part) => part.text).join('');
  const dynamic = !escaped && literal.startsWith('$');
  const honoSyntax = dynamic ? null : /[:{}*?]/.exec(literal);
  if (honoSyntax) {
    throw new Error(
      `[shinro] Invalid route ${file}: segment ${JSON.stringify(
        literal
      )} contains ${JSON.stringify(
        honoSyntax[0]
      )}, which is Hono path syntax and cannot be served as a literal URL segment.`
    );
  }

  return { escaped, literal };
}

function assertGroupName(file: string, segment: string): void {
  const name = segment.slice(1, -1);

  if (name.trim() === '') {
    throw new Error(
      `[shinro] Invalid route ${file}: route group ${JSON.stringify(
        segment
      )} needs a name. Name it after what its routes share, such as "(authed)".`
    );
  }

  if (name.startsWith('$')) {
    throw new Error(
      `[shinro] Invalid route ${file}: route group ${JSON.stringify(
        segment
      )} cannot declare a dynamic parameter. A group contributes middleware only, so ${JSON.stringify(
        name
      )} would never reach the URL. Use a ${JSON.stringify(
        name
      )} directory for the parameter.`
    );
  }
}

function assertFinalCatchAll(file: string, segments: ResolvedSegment[]): void {
  const index = segments.findIndex(
    (segment) => !segment.escaped && segment.literal.startsWith('$...')
  );

  if (index !== -1 && index !== segments.length - 1) {
    throw new Error(
      `[shinro] Invalid route ${file}: catch-all segment ${JSON.stringify(
        segments[index].literal
      )} must be final.`
    );
  }
}

function assertUniqueParameters(
  file: string,
  segments: ResolvedSegment[]
): void {
  const parameters = new Set<string>();

  for (const segment of segments) {
    if (segment.escaped || !segment.literal.startsWith('$')) {
      continue;
    }

    const parameter = segment.literal.startsWith('$...')
      ? segment.literal.slice(4)
      : segment.literal.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
      throw new Error(
        `[shinro] Invalid route ${file}: invalid dynamic parameter name ${JSON.stringify(
          parameter
        )}. Use letters, numbers, and underscores, starting with a letter or underscore.`
      );
    }
    if (parameters.has(parameter)) {
      throw new Error(
        `[shinro] Invalid route ${file}: duplicate dynamic parameter ${JSON.stringify(
          parameter
        )}. Every filename parameter in a route must have a unique name.`
      );
    }
    parameters.add(parameter);
  }
}

function toHonoSegment(segment: string): string {
  if (segment.startsWith('$...')) {
    return `:${segment.slice(4)}{.+}`;
  }

  if (segment.startsWith('$')) {
    return `:${segment.slice(1)}`;
  }

  return segment;
}
