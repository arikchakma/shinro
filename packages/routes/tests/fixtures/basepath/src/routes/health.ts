import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => c.json({ ok: true as const }));
