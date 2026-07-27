import type { ShinroLogger } from '../core/logger.ts';
import { bold, dim, green, red, yellow } from './style.ts';

/**
 * The CLI's logger. The core raises plain strings prefixed with `[shinro]`,
 * because those travel into Vite's and tsdown's loggers where a bare sentence
 * would lose its owner. On the command line the owner is the word you just
 * typed, so the prefix is replaced with a symbol and the message gets room to
 * breathe.
 *
 * The one piece of parsing here is the `- item` continuation the core uses for
 * lists — conflicting files, drifted artifacts. Those become an indented dim
 * block, which is the difference between a wall of equal-weight lines and a
 * headline with its evidence underneath.
 */
export function createReporter(): ShinroLogger {
  return {
    error: (message) => console.error(format(red('✗'), message, bold)),
    // Success is not emphasised. A watcher prints one of these per save, and a
    // column of bold is a column of nothing standing out — leaving `info`
    // plain also lets the caller style parts of its own line, which nesting
    // inside `bold` cannot do (the dim reset closes the bold too).
    info: (message) => console.info(format(green('✓'), message, plain)),
    warn: (message) => console.warn(format(yellow('!'), message, bold)),
  };
}

function plain(text: string): string {
  return text;
}

/**
 * A blank line separates independent diagnostics — the scanner reports every
 * route conflict it found, not just the first — so each block gets its own
 * headline. Only the first is marked with the symbol: they arrived as one
 * failure, and a column of `✗` would suggest otherwise.
 */
function format(
  symbol: string,
  message: string,
  emphasise: (text: string) => string
): string {
  return message
    .replace(/^\[shinro\] /, '')
    .split('\n\n')
    .map((block, index) => {
      const [headline = '', ...rest] = block.split('\n');

      return [
        // The trailing colon announced a list back when the list was flush
        // left. The indent announces it now, so the colon is one more character
        // of noise.
        `${index === 0 ? `${symbol} ` : '  '}${emphasise(
          rest.length > 0 ? headline.replace(/:$/, '') : headline
        )}`,
        ...rest.map((line) =>
          line.startsWith('- ') ? `    ${dim(line.slice(2))}` : `  ${dim(line)}`
        ),
      ].join('\n');
    })
    .join('\n\n');
}
