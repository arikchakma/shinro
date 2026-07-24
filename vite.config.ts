import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { daroyan } from "./packages/routes/src/index.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [
    daroyan({
      app: fileURLToPath(
        new URL("./packages/routes/tests/fixtures/basic/src/app.ts", import.meta.url),
      ),
      entry: fileURLToPath(
        new URL("./packages/routes/tests/fixtures/basic/src/server.ts", import.meta.url),
      ),
      routes: fileURLToPath(
        new URL("./packages/routes/tests/fixtures/basic/src/routes", import.meta.url),
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
  test: {
    include: ["packages/**/*.test.ts"],
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
