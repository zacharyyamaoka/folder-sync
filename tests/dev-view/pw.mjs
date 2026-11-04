// Playwright is ui's dependency (npm --prefix ui ci); this resolves it from there so the dev view needs no node_modules of its own.
import { createRequire } from "node:module";
const pw = createRequire(new URL("../../ui/package.json", import.meta.url))("@playwright/test");
export const { test, expect, defineConfig } = pw;
