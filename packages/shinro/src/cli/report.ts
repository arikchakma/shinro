import type { ShinroLogger } from '../core/logger.ts';
import { bold, dim, green, red, yellow } from './style.ts';

export function createReporter(): ShinroLogger {
  return {
    error: (message) => console.error(format(red('✗'), message, bold)),
    info: (message) =>
      console.info(format(green('✓'), message, (text) => text)),
    warn: (message) => console.warn(format(yellow('!'), message, bold)),
  };
}

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
