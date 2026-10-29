#!/usr/bin/env node
// A byte pipe between a TCP port and a unix socket, both ways round: the two halves that carry a host's traffic out of
// its own network namespace to its bench/fast/tcpproxy.mjs (bench/fast/README-folder-sync.md, "Network").
//
//   node bench/fast/lib/fwd.mjs --map tcp:5102=unix:/x/a-worker.sock [--map …]     inside the host's namespace
//   node bench/fast/lib/fwd.mjs --map unix:/x/a-worker.sock=tcp:5112 [--map …]     outside, into the host's proxy
//
// It counts nothing and never cuts: tcpproxy.mjs is the one place bytes are counted and a host is cut off.
// It prints one JSON line {"pid":…,"listening":[…]} once every listener is bound.
//
// WHY a namespace at all: the Worker vends one S3 endpoint (R2_ENDPOINT) and signs its host into the session token's
// aud, which the stand-in checks against Host; a per-host proxy on another port would fail that check. Inside its own
// namespace each host dials the very same 127.0.0.1:<port>, and that port is this pipe into its own proxy.

import { rmSync } from "node:fs";
import { connect, createServer } from "node:net";

function endpoint(spec) {
	const [kind, where] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
	if (kind === "tcp") return { port: Number(where), host: "127.0.0.1" };
	if (kind === "unix") return { path: where };
	throw new Error(`${spec}: use tcp:<port> or unix:<path>`);
}

const maps = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] !== "--map" || !argv[i + 1]) throw new Error(`unknown argument ${argv[i]}`);
	const [from, to] = argv[++i].split("=");
	maps.push({ from: endpoint(from), to: endpoint(to), spec: from });
}

const servers = [];
for (const m of maps) {
	if (m.from.path) rmSync(m.from.path, { force: true });
	const server = createServer((client) => {
		const upstream = connect(m.to);
		client.pipe(upstream);
		upstream.pipe(client);
		const close = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on("error", close);
		upstream.on("error", close);
		client.on("close", close);
		upstream.on("close", close);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(m.from, resolve);
	});
	servers.push(server);
}
console.log(JSON.stringify({ pid: process.pid, listening: maps.map((m) => m.spec) }));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
