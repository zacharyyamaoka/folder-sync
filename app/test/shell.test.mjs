// The journey's stand-in for the Rust shell must say what the Rust says. Run: node --test app/test/shell.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkFolderName, COMMANDS, headline, projectFromFolder, Shell } from "./shell.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", ...parts), "utf8");
const rust = read("src-tauri", "src", "core.rs");
const main = read("src-tauri", "src", "main.rs");
const page = read("ui", "index.html");
const script = read("ui", "app.js");

test("every headline the journey shell can show is a headline core.rs shows", () => {
	for (const status of [{ state: "signed_out" }, { state: "sign_in_failed" }, { state: "needs_folder" }, { state: "starting" }, { state: "syncing" }, { state: "offline" }, { state: "over_quota" }, { state: "paused" }, { state: "error" }]) {
		assert.ok(rust.includes(`"${headline(status)}"`), `core.rs has no "${headline(status)}"`);
	}
	assert.ok(rust.includes('format!("Signing in: approve {code} in your browser")'));
	assert.equal(headline({ state: "signing_in", code: "AB12" }), "Signing in: approve AB12 in your browser");
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
	assert.equal(shell.status.machines, 1, "of two peers one is the shared tree");
	shell.onEvent({ event: "round", ok: false, kind: "over_quota", why: "12 GiB" });
	shell.onEvent({ event: "round", ok: false, kind: "offline", why: "no route" });
	shell.onEvent({ event: "round", ok: false, kind: "signed_out" });
	shell.onEvent({ event: "round", ok: false, kind: "other", why: "boom" });
	assert.deepEqual(seen, ["syncing", "synced", "over_quota", "offline", "signed_out", "error"]);
	for (const word of ['Some("signed_out")', 'Some("over_quota")', 'Some("offline")', 'if source != "timer"', "saturating_sub(1)"]) assert.ok(rust.includes(word), word);
	assert.equal(shell.snapshot().detail, "boom");
});

test("the folder is shown the way the app shows it: ~/folder-sync", () => {
	const shell = new Shell({ machine: { home: "/home/x" }, email: "e", server: "s", onState() {} });
	assert.equal(shell.snapshot().default_parent, process.platform === "win32" ? "/home/x/Documents/folder-sync" : "~/folder-sync");
	assert.ok(rust.includes('home.join("folder-sync")'));
});

test("the page's IPC commands are the ones main.rs registers, and the shell answers every one", () => {
	const registered = /generate_handler!\[([^\]]*)\]/.exec(main)[1].split(",").map((name) => name.trim()).filter(Boolean);
	assert.deepEqual([...registered].sort(), [...COMMANDS].sort());
	const invoked = new Set([...script.matchAll(/invoke\("([a-z_]+)"/g)].map((m) => m[1]));
	for (const name of invoked) assert.ok(registered.includes(name), `app.js invokes ${name}, which main.rs does not register`);
});

test("every button's action is an action the Rust menu handler has", () => {
	const actions = new Set([...page.matchAll(/data-action="([a-z_]+)"/g)].map((m) => m[1]));
	assert.ok(actions.has("choose_folder") && actions.has("open_online") && actions.has("cancel_picker"));
	for (const action of actions) assert.ok(main.includes(`"${action}" =>`), `main.rs on_menu has no "${action}"`);
});

test("folder names become projects as the engine and core.rs do", () => {
	for (const [typed, project] of [["My Notes", "my-notes"], ["vibetracks", "vibetracks"], ["_hidden", "hidden"], ["日本", "project"], ["___", "project"]]) assert.equal(projectFromFolder(typed), project);
	assert.equal(checkFolderName("  Field notes "), "Field notes");
	for (const bad of ["", ".", "..", "a/b", "a\\b", "c:"]) assert.throws(() => checkFolderName(bad), /Give the folder a name/);
	assert.ok(rust.includes("Give the folder a name"));
});

test("the picker's refusals are the Rust's words", () => {
	for (const words of ["You already have a folder named", "Pick a folder inside your home folder", "is not empty. Choose an empty place for", "A server address starts with https://", "Sign out first: a sign-in belongs to one server."]) {
		assert.ok(rust.includes(words), `core.rs has no "${words}"`);
	}
});

test("the shell runs the engine commands core.rs does, in its order: init, then share, then the engine", () => {
	const useFolder = rust.slice(rust.indexOf("pub fn use_folder"), rust.indexOf("fn log_line"));
	assert.ok(useFolder.indexOf('init.arg("init")') < useFolder.indexOf('.arg("share")') && useFolder.indexOf('.arg("share")') < useFolder.indexOf("start_engine(app)"));
	assert.ok(rust.includes('args(["projects", "--json"])'));
	const shellSource = read("test", "shell.mjs");
	assert.ok(shellSource.indexOf('["init"') < shellSource.indexOf('["share"'));
});
