import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => c.json({ source: "file" as const }));
