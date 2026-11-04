// The journey's stand-in for the Rust shell must say what the Rust says. Run: node --test app/test/shell.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { headline, Shell } from "./shell.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rust = readFileSync(join(here, "..", "src-tauri", "src", "core.rs"), "utf8");

test("every headline the journey shell can show is a headline core.rs shows", () => {
	for (const status of [{ state: "signed_out" }, { state: "needs_folder" }, { state: "starting" }, { state: "syncing" }, { state: "offline" }, { state: "over_quota" }, { state: "paused" }, { state: "error" }]) {
		assert.ok(rust.includes(`"${headline(status)}"`), `core.rs has no "${headline(status)}"`);
	}
	assert.ok(rust.includes('format!("Synced at {at}")') && rust.includes('format!("Synced at {at} · {others}")'));
	assert.equal(headline({ state: "synced", at: "12:34:56", machines: 0 }), "Synced at 12:34:56");
	assert.equal(headline({ state: "synced", at: "12:34:56", machines: 1 }), "Synced at 12:34:56 · 1 other machine");
	assert.equal(headline({ state: "synced", at: "12:34:56", machines: 3 }), "Synced at 12:34:56 · 3 other machines");
});

test("events become statuses as core.rs on_event does: a timer round stays quiet, a failed round is sorted by kind", () => {
	const seen = [];
	const shell = new Shell({ machine: { home: "/h" }, project: "p", email: "e", server: "s", onState: (snapshot) => seen.push(snapshot.status.state) });
	shell.onEvent({ event: "round_start", source: "timer" });
	assert.deepEqual(seen, []);
	shell.onEvent({ event: "round_start", source: "watch" });
	shell.onEvent({ event: "round", ok: true, at: "2026-11-04T12:00:00Z", peers: 2 });
	shell.onEvent({ event: "round", ok: false, kind: "over_quota", why: "12 GiB" });
	shell.onEvent({ event: "round", ok: false, kind: "offline", why: "no route" });
	shell.onEvent({ event: "round", ok: false, kind: "signed_out" });
	shell.onEvent({ event: "round", ok: false, kind: "other", why: "boom" });
	assert.deepEqual(seen, ["syncing", "synced", "over_quota", "offline", "signed_out", "error"]);
	for (const word of ['Some("signed_out")', 'Some("over_quota")', 'Some("offline")', 'if source != "timer"']) assert.ok(rust.includes(word), word);
	assert.equal(shell.snapshot().detail, "boom");
});

test("the folder is shown the way the app shows it: ~/name", () => {
	const shell = new Shell({ machine: { home: "/home/x" }, project: "robotparts", email: "e", server: "s", onState() {} });
	assert.equal(shell.snapshot().default_folder, "~/robotparts");
});
