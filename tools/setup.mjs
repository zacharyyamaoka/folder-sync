#!/usr/bin/env node
// The hero video's stack: accounts/scripts/dev.mjs from a checkout of main (the R2 stand-in, rclone serve s3,
// `wrangler dev` with a local D1), a test person signed in by email code, and two machines (two HOMEs) signed in to
// that person with `folder-sync login` (the device grant, approved by the person's session). Machine B is also
// `init`ed; machine A is left for the video to `init` on camera. Prints one JSON object; `down` stops the stack.
//
//   node setup.mjs up   --repo DIR --work DIR --cli PATH
//   node setup.mjs down --repo DIR --work DIR
//
// The sign-in and login helpers are bench/latency/bench.mjs's (lane/latency-kpi), trimmed.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
	const o = { verb: argv[0] };
	for (let i = 1; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = resolve(argv[i + 1]);
	return o;
}

class Browser {
	constructor(site) { this.site = site; this.jar = new Map(); }
	async fetch(path, { method = "GET", body, headers = {} } = {}) {
		const h = { ...headers };
		if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
		if (body !== undefined) { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
		const answer = await fetch(`${this.site}${path}`, { method, body, headers: h, redirect: "manual" });
		for (const line of answer.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const at = pair.indexOf("=");
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			if (/max-age=0/i.test(line) || value === "") this.jar.delete(name); else this.jar.set(name, value);
		}
		return answer;
	}
	write(path, init = {}) {
		const user = this.userId ? { "X-Folder-Sync-User": this.userId } : {};
		return this.fetch(path, { ...init, headers: { Origin: this.site, "X-Folder-Sync": "1", ...user, ...(init.headers || {}) } });
	}
}

async function signIn(site, email) {
	const browser = new Browser(site);
	const sent = await browser.write("/fs/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email, type: "sign-in" } });
	if (!sent.ok) throw new Error(`send code: ${sent.status} ${await sent.text()}`);
	const { code } = await (await fetch(`${site}/fs/dev/mailbox?email=${encodeURIComponent(email)}`)).json();
	const signed = await browser.write("/fs/api/auth/sign-in/email-otp", { method: "POST", body: { email, otp: code } });
	if (!signed.ok) throw new Error(`sign in: ${signed.status} ${await signed.text()}`);
	browser.userId = (await (await browser.fetch("/fs/v1/me")).json()).user?.id;
	return browser;
}

async function login(cli, env, home, browser) {
	const child = spawn(cli, ["login"], { cwd: home, env });
	let out = "";
	child.stdout.on("data", (b) => { out += b; });
	child.stderr.on("data", (b) => { out += b; });
	const exited = new Promise((r) => child.on("exit", (code) => r(code)));
	const until = Date.now() + 30_000;
	while (!/open (\S+) and approve the code (\S+)/.test(out) && Date.now() < until) await sleep(100);
	const found = /open (\S+) and approve the code (\S+)/.exec(out);
	if (!found) { child.kill(); throw new Error(`login printed no code: ${out.trim()}`); }
	const userCode = found[2].replace(/[^A-Z0-9]/gi, "").toUpperCase();
	await browser.fetch(`/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
	const approved = await browser.write("/fs/api/auth/device/approve", { method: "POST", body: { userCode } });
	if (!approved.ok) throw new Error(`device approve: ${approved.status}`);
	const code = await Promise.race([exited, sleep(60_000).then(() => "timeout")]);
	if (code !== 0) { child.kill(); throw new Error(`login exited ${code}: ${out.trim()}`); }
	return out;
}

const o = args(process.argv.slice(2));
const dev = await import(join(o.repo, "accounts", "scripts", "dev.mjs"));
const stateDir = join(o.work, "stack");
if (o.verb === "down") {
	console.log(JSON.stringify({ stopped: dev.down(stateDir) }));
	process.exit(0);
}
const stack = await dev.up(stateDir, process.env);
try {
	const browser = await signIn(stack.accounts, "demo@example.com");
	const machines = {};
	for (const name of ["a", "b"]) {
		const home = join(o.work, `home-${name}`);
		const folder = join(home, "notes");
		mkdirSync(folder, { recursive: true });
		// WHY a bare PATH and HOME: each machine is a fresh computer with only folder-sync on it
		const env = { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: stack.accounts, FOLDER_SYNC_RCLONE: process.env.RCLONE };
		const loginOut = await login(o.cli, env, home, browser);
		machines[name] = { home, folder, env, loginOut };
	}
	const b = machines.b;
	const init = spawnSync(o.cli, ["init", "--project", "notes", "--dir", b.folder], { cwd: b.home, env: b.env, encoding: "utf8" });
	if (init.status !== 0) throw new Error(`init b: ${init.stdout}${init.stderr}`);
	b.hostId = JSON.parse(readFileSync(join(b.home, ".folder-sync", "host.json"), "utf8")).id; // A gets its host id from init, on camera
	console.log(JSON.stringify({ stack, userId: browser.userId, machines }));
} catch (error) {
	dev.down(stateDir);
	throw error;
}
