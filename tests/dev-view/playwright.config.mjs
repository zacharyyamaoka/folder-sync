// Run: npm --prefix ui exec -- playwright test --config ../tests/dev-view/playwright.config.mjs
// Screenshots: DEV_VIEW_SHOTS=<dir> adds the light / dark / phone captures.
import { defineConfig } from "./pw.mjs";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.mjs",
	workers: 1,
	reporter: [["list"]],
	outputDir: process.env.TMPDIR ? `${process.env.TMPDIR}/folder-sync-dev-view-results` : "test-results",
	use: { browserName: "chromium", viewport: { width: 1100, height: 800 }, locale: "en-US", timezoneId: "UTC", colorScheme: "light" },
});
