import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import type { Logger } from "vite-plus";

type TypeScriptConfig = {
  compilerOptions?: {
    module?: string;
    moduleResolution?: string;
    rootDirs?: string[];
    strict?: boolean;
  };
  extends?: string;
  include?: string[];
};

export async function validateTypeScriptConfig(options: {
  logger: Logger;
  outputDirectory: string;
  root: string;
}): Promise<void> {
  const file = resolve(options.root, "tsconfig.json");
  let config: TypeScriptConfig | undefined;

  try {
    config = await readTypeScriptConfig(file, new Set());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    return;
  }
  if (!config) {
    return;
  }

  const generatedDirectory = relative(options.root, options.outputDirectory).split(sep).join("/");
  const generatedTypes = normalizeConfigPath(`./${generatedDirectory}/types`);
  const rootDirs = config.compilerOptions?.rootDirs?.map(normalizeConfigPath) ?? [];
  const includes = config.include?.map(normalizeConfigPath) ?? [];
  const valid =
    config.compilerOptions?.strict === true &&
    config.compilerOptions.module?.toLowerCase() === "esnext" &&
    config.compilerOptions.moduleResolution?.toLowerCase() === "bundler" &&
    rootDirs.includes(".") &&
    rootDirs.includes(generatedTypes) &&
    includes.some(
      (include) =>
        include === `${normalizeConfigPath(generatedDirectory)}/**/*.d.ts` ||
        include === `${normalizeConfigPath(generatedDirectory)}/**/*`,
    );

  if (valid) {
    return;
  }

  options.logger.warn(
    [
      `[daroyan] ${file} is missing settings required for generated route types.`,
      "Merge this configuration:",
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            rootDirs: [".", `./${generatedDirectory}/types`],
          },
          include: ["app", `${generatedDirectory}/**/*.d.ts`],
        },
        undefined,
        2,
      ),
    ].join("\n"),
  );
}

async function readTypeScriptConfig(
  file: string,
  seen: Set<string>,
): Promise<TypeScriptConfig | undefined> {
  if (seen.has(file)) {
    return undefined;
  }
  seen.add(file);

  const source = await readFile(file, "utf8");
  const config = JSON.parse(stripJsonComments(source)) as TypeScriptConfig;
  if (!config.extends) {
    return config;
  }

  let baseFile: string;
  if (config.extends.startsWith(".") || config.extends.startsWith("/")) {
    const unresolvedBase = resolve(dirname(file), config.extends);
    baseFile = extname(unresolvedBase) ? unresolvedBase : `${unresolvedBase}.json`;
  } else {
    try {
      baseFile = createRequire(file).resolve(config.extends);
    } catch {
      return config;
    }
  }
  const base = await readTypeScriptConfig(baseFile, seen);
  if (!base) {
    return config;
  }

  return {
    ...base,
    ...config,
    compilerOptions: {
      ...base.compilerOptions,
      ...config.compilerOptions,
    },
  };
}

function normalizeConfigPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

function stripJsonComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    output += character;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}
