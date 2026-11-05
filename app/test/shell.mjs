// The desktop window's shell, for the journey test (app/test/journey.mjs). The real shell is Rust (src-tauri/src/core.rs): it
// keeps the sign-in in the OS keychain, runs `folder-sync sync --watch --events` as the window's engine, turns each event into a
// status, and answers the page's IPC calls (the COMMANDS below). A keychain, a tray, a native dialog and a native window cannot be
// driven headless on three CI runners, so this file plays that Rust part in Node: the same engine commands in the same order, the
// same events turned into the same statuses and headlines, and the page (app/ui) unchanged on top. What it does NOT prove is the
// Rust itself: that is `cargo test` (core.rs), the installer smoke (desktop-smoke.yml) and app/scripts/real_window.mjs (the real
// binary on a virtual display). WHY the headlines, the command names and the engine calls are checked against the Rust by a test
// (shell.test.mjs): this copy must not drift from the one that ships.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The IPC commands the page may invoke: the names in main.rs's generate_handler!. */
export const COMMANDS = ["snapshot", "action", "create_folder", "join_folder", "open_existing", "pick_location", "set_server", "refresh_online"];

/** Status::headline() of core.rs. */
export function headline(status) {
	switch (status.state) {
		case "signed_out": return "Signed out";
		case "signing_in": return `Signing in: approve ${status.code} in your browser`;
		case "sign_in_failed": return "Sign-in failed";
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

/** core.rs project_from_folder (and config.ProjectFromFolder in Go): the project a folder's name gets. */
export function projectFromFolder(name) {
	let project = [...name.toLowerCase()].map((c) => (/[a-z0-9._-]/.test(c) ? c : "-")).join("").replace(/^[._-]+/, "");
	if (!project) project = "project";
	return project.slice(0, 63);
}

/** core.rs check_folder_name. */
export function checkFolderName(name) {
	const trimmed = name.trim();
	if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\:]/.test(trimmed)) throw new Error("Give the folder a name: letters, digits and spaces, no slashes.");
	return trimmed;
}

const lastLine = (text) => text.trim().split("\n").pop() || "the engine stopped without saying why";

export class Shell {
	/** machine: a harness Machine (a HOME and the engine); onState: called with every new snapshot; onOpen: the system browser;
	 *  serverLocked: FOLDER_SYNC_SERVER decides the server, as it does in every test run. */
	constructor({ machine, email = null, server, onState, onOpen = () => {}, serverLocked = true }) {
		Object.assign(this, { machine, email, server, onState, onOpen, serverLocked });
		this.status = { state: "signed_out" };
		this.signedIn = false;
		this.folder = null;
		this.project = null;
		this.picking = false;
		this.online = { state: "idle" };
		this.paused = false;
		this.engine = null;
		this.login = null;
		this.dialogAnswers = []; // what the native folder dialog will return, in order (null: the person closed it)
		this.opened = []; // folders handed to the OS file manager and addresses handed to the browser, in order
		this.rounds = []; // every finished round event, as the engine printed it
		this.history = []; // every state the window was told, in order
		this.log = "";
	}

	get defaultParent() {
		return process.platform === "win32" ? join(this.machine.home, "Documents", "folder-sync") : join(this.machine.home, "folder-sync");
	}
	// core.rs tilde(): ~/name on Linux and macOS, the full path on Windows
	tilde(path) { return process.platform !== "win32" && path.startsWith(this.machine.home) ? `~${path.slice(this.machine.home.length)}` : path; }

	/** core.rs site_of: the Files page, on the folder's project when there is one. */
	get site() {
		const page = `${this.server.replace(/\/+$/, "")}/fs/files`;
		return this.project && this.folder ? `${page}?project=${this.project}` : page;
	}

	snapshot() {
		const s = this.status;
		return {
			status: s, headline: headline(s), detail: s.why || null, icon: s.state, signed_in: this.signedIn, email: this.signedIn ? this.email : null, server: this.server, site: this.site,
			folder: this.folder && this.tilde(this.folder), project: this.project, default_parent: this.tilde(this.defaultParent), default_parent_path: this.defaultParent,
			picking: this.signedIn && (this.picking || s.state === "needs_folder"), online: this.online, paused: this.paused, autostart: false, server_locked: this.serverLocked,
		};
	}

	push() { this.onState(this.snapshot()); }

	set(status) {
		if (JSON.stringify(status) === JSON.stringify(this.status)) return;
		this.status = status;
		this.history.push(status.state);
		this.push();
	}

	/** The page's `invoke(command, args)`: the page's IPC. A command the Rust does not have is a test bug. */
	async invoke(command, args) {
		switch (command) {
			case "snapshot": return this.snapshot();
			case "action": return this.action(args.id);
			case "create_folder": return this.createFolder(args.name, args.parent);
			case "join_folder": return this.joinFolder(args.project, args.parent);
			case "open_existing": return this.openExisting();
			case "pick_location": return this.pickLocation();
			case "set_server": return this.setServer(args.server);
			case "refresh_online": return this.refreshOnline();
			default: throw new Error(`the journey shell does not implement the command ${command}`);
		}
	}

	/** main.rs on_menu: only the buttons the journey presses; any other is a test bug, not a no-op. */
	async action(id) {
		switch (id) {
			case "sign_in": return this.signIn();
			case "choose_folder": this.picking = true; this.push(); return this.refreshOnline();
			case "cancel_picker": this.picking = false; this.push(); return;
			case "open_folder": this.opened.push(this.folder); return;
			case "open_online": this.opened.push(this.site); return;
			case "pause": return this.pause();
			case "resume": return this.startEngine();
			default: throw new Error(`the journey shell does not implement the action ${id}`);
		}
	}

	// ---------------------------------------------------------------- sign in (core.rs sign_in)

	/** `folder-sync login --json --print-token`: the `device` event opens the browser; `signed_in` carries the session, which the
	 *  real app moves into the keychain and this file into account.json (WHY: the engine finds the session there). */
	signIn() {
		if (this.login) return;
		const child = spawn(this.machine.cli, ["login", "--json", "--print-token", "--server", this.server], { cwd: this.machine.home, env: this.machine.env });
		this.login = child;
		let pending = "";
		child.stdout.on("data", (b) => {
			pending += b;
			const lines = pending.split("\n");
			pending = lines.pop();
			for (const line of lines) {
				let ev;
				try { ev = JSON.parse(line); } catch { continue; }
				if (ev.event === "device") {
					this.set({ state: "signing_in", code: ev.user_code, link: ev.link });
					this.opened.push(ev.link);
					this.onOpen(ev.link, ev.user_code);
				} else if (ev.event === "signed_in") {
					mkdirSync(join(this.machine.home, ".folder-sync"), { recursive: true });
					writeFileSync(join(this.machine.home, ".folder-sync", "account.json"), JSON.stringify(ev.account), { mode: 0o600 });
					this.signedIn = true;
					this.email = ev.user.email;
					this.set({ state: "needs_folder" });
					this.refreshOnline();
				} else if (ev.event === "error") {
					this.set({ state: "sign_in_failed", why: ev.error || "sign-in failed" });
				}
			}
		});
		child.on("exit", () => { this.login = null; });
	}

	// ---------------------------------------------------------------- the folder (core.rs "The folder")

	/** core.rs refresh_online: `folder-sync projects --json`. */
	async refreshOnline() {
		if (!this.signedIn) return;
		this.online = { state: "loading" };
		this.push();
		const done = await new Promise((resolveRun) => {
			const child = spawn(this.machine.cli, ["projects", "--json"], { cwd: this.machine.home, env: this.machine.env });
			let out = "";
			let err = "";
			child.stdout.on("data", (b) => { out += b; });
			child.stderr.on("data", (b) => { err += b; });
			child.on("exit", (code) => resolveRun({ code, out, err }));
		});
		if (done.code !== 0) this.online = { state: "failed", why: lastLine(done.err) };
		else this.online = { state: "ready", folders: JSON.parse(done.out).projects || [] };
		this.push();
	}

	/** core.rs create_folder. */
	async createFolder(name, parent) {
		const typed = checkFolderName(name);
		const project = projectFromFolder(typed);
		if (this.online.state === "ready" && this.online.folders.includes(project)) {
			throw new Error(`You already have a folder named ${project} online. Pick it under Your folders online to download it, or give this one another name.`);
		}
		return this.useFolder(join(parent, typed), null, true);
	}

	/** core.rs open_existing_folder. */
	async openExistingFolder(folder) {
		if (folder === this.machine.home || resolve(folder, "..") === folder) throw new Error("Pick a folder inside your home folder, not the home folder itself.");
		return this.useFolder(folder, null, true);
	}

	/** main.rs open_existing: the native dialog, then the folder. */
	async openExisting() {
		const picked = this.dialogAnswers.shift();
		if (!picked) return false;
		await this.openExistingFolder(picked);
		return true;
	}

	/** main.rs pick_location. */
	async pickLocation() { return this.dialogAnswers.shift() || null; }

	/** core.rs join_folder. */
	async joinFolder(project, parent) {
		const folder = join(parent, project);
		let own = false;
		let busy = false;
		try { own = new RegExp(`^\\s*project\\s*=\\s*"${project}"`, "m").test(readFileSync(join(folder, ".folder-sync.toml"), "utf8")); } catch { /* no folder yet */ }
		try { busy = readdirSync(folder).length > 0; } catch { /* no folder yet */ }
		if (busy && !own) throw new Error(`${folder} is not empty. Choose an empty place for ${project}.`);
		return this.useFolder(folder, project, true);
	}

	/** core.rs use_folder: make the folder, `init`, `share` for a folder this machine starts, then stop the old engine and start
	 *  the new one. Nothing about the running folder changes until `init` has succeeded. */
	async useFolder(folder, project, share) {
		mkdirSync(folder, { recursive: true });
		const init = this.machine.run(["init", ...(project ? ["--project", project] : []), "--dir", folder]);
		if (init.code !== 0) throw new Error(lastLine(init.err));
		if (share) {
			const shared = this.machine.run(["share", "--dir", folder]);
			if (shared.code !== 0) throw new Error(lastLine(shared.err));
		}
		let named = project;
		try { named = /^\s*project\s*=\s*"([^"]*)"/m.exec(readFileSync(join(folder, ".folder-sync.toml"), "utf8"))[1]; } catch { /* keep the asked-for name */ }
		await this.stopEngine();
		this.folder = folder;
		this.project = named;
		this.paused = false;
		this.picking = false;
		this.startEngine();
	}

	/** core.rs set_server. */
	async setServer(server) {
		if (this.serverLocked) throw new Error("FOLDER_SYNC_SERVER decides the server in this run.");
		if (!/^https?:\/\/\S+$/.test(server.trim())) throw new Error("A server address starts with https:// (or http:// for a local one).");
		if (this.signedIn || this.login) throw new Error("Sign out first: a sign-in belongs to one server.");
		this.server = server.trim().replace(/\/+$/, "");
		this.push();
	}

	// ---------------------------------------------------------------- the engine (core.rs start_engine, on_event)

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
			if (ev.ok === true) this.set({ state: "synced", at: localHms(ev.at), machines: Math.max(0, (ev.peers || 0) - 1) }); // core.rs: the shared tree is one of the peers
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
