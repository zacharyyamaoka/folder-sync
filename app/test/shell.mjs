// The desktop window's shell, for the journey test (app/test/journey.mjs). The real shell is Rust (src-tauri/src/core.rs): it
// keeps the sign-in in the OS keychain, runs `folder-sync sync --watch --events` as the window's engine, turns each event into a
// status, and answers the page's two IPC calls (`snapshot`, `action`). A keychain, a tray and a native window cannot be driven
// headless on three CI runners, so this file plays that Rust part in Node: the same engine commands, the same events turned into
// the same statuses and headlines, and the page (app/ui) unchanged on top. What it does NOT prove is the Rust itself: that is
// `cargo test` (core.rs), the installer smoke (desktop-smoke.yml) and app/scripts/proof_linux.py (the real AppImage, by hand).
// WHY the headlines are checked against core.rs by a test: this copy must not drift from the one that ships.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Status::headline() of core.rs. */
export function headline(status) {
	switch (status.state) {
		case "signed_out": return "Signed out";
		case "needs_folder": return "Signed in: choose your folder";
		case "starting": return "Starting…";
		case "syncing": return "Syncing…";
		case "synced": {
			const others = status.machines === 1 ? "1 other machine" : `${status.machines} other machines`;
			return status.machines === 0 ? `Synced at ${status.at}` : `Synced at ${status.at} · ${others}`;
		}
		case "offline": return "Offline: will sync when the server answers";
		case "over_quota": return "Over quota: not uploading";
		case "paused": return "Paused";
		case "error": return "Sync error";
		default: throw new Error(`the journey shell has no headline for the state ${status.state}`);
	}
}

/** HH:MM:SS of an RFC 3339 stamp in local time (core.rs local_hms). */
export function localHms(stamp) {
	const at = new Date(stamp);
	return Number.isNaN(at.getTime()) ? "" : at.toTimeString().slice(0, 8);
}

export class Shell {
	/** machine: a harness Machine already signed in (its account.json is the "keychain"); project: the folder's project name. */
	constructor({ machine, project, email, server, onState }) {
		Object.assign(this, { machine, project, email, server, onState });
		this.status = { state: "needs_folder" };
		this.folder = null;
		this.paused = false;
		this.engine = null;
		this.opened = []; // folders the "Open folder" button handed to the OS file manager
		this.rounds = []; // every finished round event, as the engine printed it
		this.history = []; // every state the window was told, in order
		this.log = "";
	}

	get defaultFolder() { return join(this.machine.home, this.project); }
	// core.rs tilde(): ~/name on Linux and macOS, the full path on Windows
	tilde(path) { return process.platform !== "win32" && path.startsWith(this.machine.home) ? `~${path.slice(this.machine.home.length)}` : path; }

	snapshot() {
		const s = this.status;
		return {
			status: s, headline: headline(s), detail: s.why || null, icon: s.state, email: this.email, server: this.server, site: `${this.server}/saved/`,
			folder: this.folder && this.tilde(this.folder), default_folder: this.tilde(this.defaultFolder), paused: this.paused, autostart: false,
		};
	}

	set(status) {
		if (JSON.stringify(status) === JSON.stringify(this.status)) return;
		this.status = status;
		this.history.push(status.state);
		this.onState(this.snapshot());
	}

	/** The page's `invoke("action", { id })`: only the buttons the journey presses; any other is a test bug, not a no-op. */
	async action(id) {
		switch (id) {
			case "create_folder": return this.useFolder(this.defaultFolder);
			case "open_folder": this.opened.push(this.folder); return;
			case "pause": return this.pause();
			case "resume": return this.startEngine();
			default: throw new Error(`the journey shell does not implement the action ${id}`);
		}
	}

	/** core.rs use_folder: make the folder, `folder-sync init --project P --dir F`, start the engine. */
	useFolder(folder) {
		this.set({ state: "starting" });
		mkdirSync(folder, { recursive: true });
		this.machine.must(["init", "--project", this.project, "--dir", folder]);
		this.folder = folder;
		this.startEngine();
	}

	/** core.rs start_engine: `sync --watch --events --dir F`, stdout is folder-sync-event/1 lines. */
	startEngine() {
		this.paused = false;
		this.set({ state: "starting" });
		const child = spawn(this.machine.cli, ["sync", "--watch", "--events", "--dir", this.folder], { cwd: this.machine.home, env: this.machine.env });
		this.engine = child;
		child.stderr.on("data", (b) => { this.log += b; });
		let pending = "";
		child.stdout.on("data", (b) => {
			pending += b;
			const lines = pending.split("\n");
			pending = lines.pop();
			for (const line of lines) {
				try { this.onEvent(JSON.parse(line)); } catch { /* a human line, not an event */ }
			}
		});
	}

	/** core.rs on_event. */
	onEvent(ev) {
		if (ev.event === "round_start") {
			if (ev.source !== "timer") this.set({ state: "syncing" }); // WHY: the minute-by-minute safety-net round must not flicker the icon
		} else if (ev.event === "round") {
			this.rounds.push(ev);
			if (ev.ok === true) this.set({ state: "synced", at: localHms(ev.at), machines: ev.peers || 0 });
			else if (ev.kind === "signed_out") this.set({ state: "signed_out" });
			else if (ev.kind === "over_quota") this.set({ state: "over_quota", why: ev.why || "" });
			else if (ev.kind === "offline") this.set({ state: "offline", why: ev.why || "" });
			else this.set({ state: "error", why: ev.why || "" });
		}
	}

	async pause() {
		this.paused = true;
		await this.stopEngine();
		this.set({ state: "paused" });
	}

	/** SIGTERM and wait: `--watch` finishes its round and the manifest publish first (core.rs stop_engine). */
	async stopEngine() {
		const child = this.engine;
		this.engine = null;
		if (!child || child.exitCode !== null) return;
		child.kill("SIGTERM");
		const until = Date.now() + 15_000;
		while (child.exitCode === null && child.signalCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}
