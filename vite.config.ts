import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { daroyan } from "./packages/routes/src/index.ts";

export default defineConfig({
  plugins: [
    daroyan({
      app: fileURLToPath(
        new URL("./packages/routes/tests/fixtures/basic/app/app.ts", import.meta.url),
      ),
      entry: fileURLToPath(
        new URL("./packages/routes/tests/fixtures/basic/app/server.ts", import.meta.url),
      ),
      routes: fileURLToPath(
        new URL("./packages/routes/tests/fixtures/basic/app/routes", import.meta.url),
      ),
    }),
  ],
  resolve: {
    alias: {
      "daroyan/app": fileURLToPath(new URL("./packages/routes/src/app.ts", import.meta.url)),
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
