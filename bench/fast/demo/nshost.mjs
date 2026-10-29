#!/usr/bin/env node
// One machine's network for the hero recorder (bench/fast/demo/hero.mjs), run as the first process of that machine's
// own network namespace (`unshare -rn`). The machine's path out is the bench's, hop for hop:
//
//   folder-sync -> tcpproxy.mjs (here) -> lib/fwd.mjs (here) -> unix socket -> lib/fwd.mjs (outside) -> the stack
//
//   node bench/fast/demo/nshost.mjs --pass <listen>:<via> [--pass …] --map tcp:<via>=unix:<sock> [--map …]
//
// Each --pass is one bench/fast/tcpproxy.mjs (startProxy, unchanged) on 127.0.0.1:<listen> to 127.0.0.1:<via>; the
// --map flags go to a lib/fwd.mjs child. It prints one JSON line {"pid":…,"fwd_pid":…} once both are up, and stops
// its fwd child by pid when it is stopped.
//
// WHY the proxies inside the namespace and not outside, as fs_bench.mjs has them: the recorder owns ten host ports
// (5140-5149) and the bench's layout needs four per machine; ports inside this namespace are this namespace's own.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../tcpproxy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const passes = [];
const maps = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--pass" && argv[i + 1]) {
		const [listen, via] = argv[++i].split(":").map(Number);
		passes.push({ listen, via });
	} else if (argv[i] === "--map" && argv[i + 1]) maps.push("--map", argv[++i]);
	else throw new Error(`unknown argument ${argv[i]}`);
}

const fwd = spawn(process.execPath, [join(HERE, "..", "lib", "fwd.mjs"), ...maps], { stdio: ["ignore", "pipe", "inherit"] });
const stopFwd = () => {
	try { fwd.kill("SIGTERM"); } catch { /* gone */ }
};
process.on("exit", stopFwd);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
fwd.on("exit", (code) => {
	console.error(`nshost: fwd.mjs exited ${code}`);
	process.exit(1);
});
await new Promise((resolve) => {
	let out = "";
	fwd.stdout.on("data", (b) => {
		out += b;
		if (out.includes("\n")) resolve();
	});
});
for (const p of passes) {
	// control on port 0: a port of this namespace's that nothing here reads (nothing is counted or cut in a recording)
	await startProxy({ listen: p.listen, control: 0, host: "127.0.0.1", targetHost: "127.0.0.1", targetPort: p.via, delayMs: 0 });
}
console.log(JSON.stringify({ pid: process.pid, fwd_pid: fwd.pid, passes }));
