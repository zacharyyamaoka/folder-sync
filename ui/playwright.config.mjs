// <folder-sync-status>'s tests: Chromium, each test with its own stub (test/stub.mjs) over testdata/view-api/.
// One worker, so the suite can check at the end that every fixture the element reads was rendered.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "test",
	testMatch: "*.spec.mjs",
	workers: 1,
	reporter: [["list"]],
	outputDir: process.env.TMPDIR ? `${process.env.TMPDIR}/folder-sync-ui-results` : "test-results",
	use: {
		browserName: "chromium",
		viewport: { width: 1100, height: 700 },
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "light",
	},
});
