import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => c.json({ route: "api" as const }));
