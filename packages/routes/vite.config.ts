import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { daroyan } from "./src/index.ts";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const fixture = fileURLToPath(new URL("./tests/fixtures/basic", import.meta.url));

export default defineConfig({
  root: packageRoot,
  plugins: [
    daroyan({
      app: `${fixture}/app/app.ts`,
      routes: `${fixture}/app/routes`,
    }),
  ],
  resolve: {
    alias: {
      "daroyan/app": fileURLToPath(new URL("./src/app.ts", import.meta.url)),
    },
  },
  pack: {
    entry: ["src/index.ts", "src/app.ts", "src/entry.ts"],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
