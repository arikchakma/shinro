/**
 * Sixteen lines of SGR instead of a colour dependency. The CLI only ever needs
 * eight colours applied to whole strings, and a package for that would be a
 * package to keep up to date.
 *
 * `NO_COLOR` and a non-TTY stdout both disable it, which is what keeps
 * `shinro generate` a clean set of lines in a CI log.
 */
const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY === true;

function sgr(open: number, close: number): (text: string) => string {
  return (text) => (enabled ? `\u001B[${open}m${text}\u001B[${close}m` : text);
}

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const blue = sgr(34, 39);
export const magenta = sgr(35, 39);
export const cyan = sgr(36, 39);

/** Verb colours, so a route table is scannable by method before it is read. */
export function method(verb: string): string {
  switch (verb) {
    case 'GET': {
      return blue(verb);
    }
    case 'POST': {
      return green(verb);
    }
    case 'PATCH':
    case 'PUT': {
      return yellow(verb);
    }
    case 'DELETE': {
      return red(verb);
    }
    default: {
      return magenta(verb);
    }
  }
}
