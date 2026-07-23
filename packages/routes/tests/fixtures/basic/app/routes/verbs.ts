import { defineHandler } from "daroyan/app";

export const PUT = defineHandler((c) => c.json({ method: "PUT" as const }, 200));

export const PATCH = defineHandler((c) => c.json({ method: "PATCH" as const }, 200));

export const DELETE = defineHandler((c) => c.json({ method: "DELETE" as const }, 200));

export const OPTIONS = defineHandler((c) => c.json({ method: "OPTIONS" as const }, 200));
