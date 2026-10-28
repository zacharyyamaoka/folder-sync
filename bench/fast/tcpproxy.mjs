#!/usr/bin/env node
// The bench's one network seam (bench/fast/CONTRACT.md): every host reaches its peers and the store through one of these,
// so the bench can count each host's bytes and cut a host off (the `drop` fault) the same way for every tool.
//
//   node bench/fast/tcpproxy.mjs --listen 5101 --target 127.0.0.1:5102 --control 5103 [--delay-ms 0]
//
// Control (HTTP on 127.0.0.1:<control>):
//   GET  /stats    {"bytes_in":…,"bytes_out":…,"conns":…,"open":…,"cut":false}   in = client->target, out = target->client
//   POST /cut      destroy every open connection and refuse (reset) new ones until /restore
//   POST /restore  accept again
//   POST /reset    zero the counters
// It prints one JSON line {"listen":…,"control":…,"pid":…} once both ports are bound.
//
// WHY a userspace proxy and not netem/iptables: those need root, and the bench must run as Zach with no sudo.

import { createServer as createHttp } from "node:http";
import { connect, createServer } from "node:net";

function options(argv) {
	const o = { listen: 0, target: null, control: 0, delayMs: 0, host: "127.0.0.1" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--listen") o.listen = Number(next());
		else if (a === "--target") o.target = next();
		else if (a === "--control") o.control = Number(next());
		else if (a === "--delay-ms") o.delayMs = Number(next());
		else throw new Error(`unknown argument ${a}`);
	}
	if (!o.target) throw new Error("--target host:port is required");
	const at = o.target.lastIndexOf(":");
	o.targetHost = o.target.slice(0, at);
	o.targetPort = Number(o.target.slice(at + 1));
	return o;
}

export function startProxy(o) {
	const stats = { bytes_in: 0, bytes_out: 0, conns: 0, open: 0, cut: false };
	const live = new Set();
	const later = (fn) => (o.delayMs > 0 ? setTimeout(fn, o.delayMs) : fn());

	const server = createServer((client) => {
		if (stats.cut) {
			client.resetAndDestroy();
			return;
		}
		stats.conns++;
		stats.open++;
		const upstream = connect(o.targetPort, o.targetHost);
		const pair = { client, upstream };
		live.add(pair);
		const close = () => {
			if (!live.delete(pair)) return;
			stats.open--;
			client.destroy();
			upstream.destroy();
		};
		client.on("data", (b) => {
			stats.bytes_in += b.length;
			later(() => upstream.write(b));
		});
		upstream.on("data", (b) => {
			stats.bytes_out += b.length;
			later(() => client.write(b));
		});
		client.on("end", () => later(() => upstream.end()));
		upstream.on("end", () => later(() => client.end()));
		for (const s of [client, upstream]) {
			s.on("error", close);
			s.on("close", close);
		}
	});

	const control = createHttp((req, res) => {
		const send = (body) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.method === "GET" && req.url === "/stats") return send(stats);
		if (req.method === "POST" && req.url === "/cut") {
			stats.cut = true;
			for (const { client, upstream } of live) {
				client.resetAndDestroy();
				upstream.destroy();
			}
			return send(stats);
		}
		if (req.method === "POST" && req.url === "/restore") {
			stats.cut = false;
			return send(stats);
		}
		if (req.method === "POST" && req.url === "/reset") {
			stats.bytes_in = 0;
			stats.bytes_out = 0;
			stats.conns = 0;
			return send(stats);
		}
		res.writeHead(404);
		res.end();
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		control.once("error", reject);
		server.listen(o.listen, o.host, () => {
			control.listen(o.control, o.host, () => resolve({ server, control, stats, listen: server.address().port, controlPort: control.address().port }));
		});
	});
}

/** Client helpers for a harness: the proxy's control port. */
export const proxyControl = {
	stats: async (port) => (await fetch(`http://127.0.0.1:${port}/stats`)).json(),
	cut: async (port) => (await fetch(`http://127.0.0.1:${port}/cut`, { method: "POST" })).json(),
	restore: async (port) => (await fetch(`http://127.0.0.1:${port}/restore`, { method: "POST" })).json(),
	reset: async (port) => (await fetch(`http://127.0.0.1:${port}/reset`, { method: "POST" })).json(),
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const o = options(process.argv.slice(2));
	const p = await startProxy(o);
	console.log(JSON.stringify({ listen: p.listen, control: p.controlPort, pid: process.pid }));
	for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
}
