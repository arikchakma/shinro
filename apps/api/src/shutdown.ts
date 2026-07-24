import type { ServerType } from "@hono/node-server";

let stopping: Promise<void> | undefined;

export function shutdown(server: ServerType, signal: NodeJS.Signals): Promise<void> {
  if (stopping) {
    return stopping;
  }

  stopping = new Promise<void>((resolve, reject) => {
    console.info(`[api] ${signal} received; draining requests`);
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      console.info("[api] HTTP server closed");
      resolve();
    });
  }).catch((error: unknown) => {
    process.exitCode = 1;
    console.error("[api] Graceful shutdown failed", error);
  });

  return stopping;
}
