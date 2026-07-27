export type ShinroLogger = {
  error: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Writes to the console. Messages already carry the `[shinro]` prefix from
 * wherever they were raised, so the logger stays a pass-through — one prefix,
 * applied at the source, survives being forwarded into a host's logger.
 */
export function createLogger(): ShinroLogger {
  return {
    error: (message) => console.error(message),
    info: (message) => console.info(message),
    warn: (message) => console.warn(message),
  };
}

export function fromHost(host: Partial<ShinroLogger>): ShinroLogger {
  const fallback = createLogger();

  return {
    error: host.error ?? fallback.error,
    info: host.info ?? fallback.info,
    warn: host.warn ?? fallback.warn,
  };
}
