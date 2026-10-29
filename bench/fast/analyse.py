#!/usr/bin/env python3
"""Fast Folder Sync (PEP 0008): raw bench rows -> one summary, the cost model, the frontier and the Vibe Tracks KPIs.

    python3 bench/fast/analyse.py --tag 20261028 [--no-kpi] [--out ~/vt/zach/producers/folder-sync-bench]

Reads bench/fast/results/raw/{fs,co,sw}-*-<tag>*.jsonl (CONTRACT.md rows). Writes
bench/fast/results/summary-<tag>.json (the report reads it) and, unless --no-kpi, the producer folder
producers/folder-sync-bench that the Vibe Tracks track `faster-folder-sync` reads: kpi_catalog.json (rewritten),
kpi_series.jsonl and runs_table.jsonl (appended).

Stdlib only. Every number here is computed from measured rows, except the cost model's scale assumptions
(COST_MODEL below), which are labelled "modelled" wherever they appear.
"""
import argparse
import glob
import json
import os
import socket
import subprocess
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "results", "raw")
DIRECTIONS = ["m2m", "m2w", "w2m", "m2a", "offline"]
DIRECTION_TITLES = {
    "m2m": "machine to machine",
    "m2w": "machine to web",
    "w2m": "web to machine",
    "m2a": "machine to agent/CLI",
    "offline": "offline catch-up (network drop)",
}
BENCH_VERSION = "fast-folder-sync/1"

# WHY these numbers: the scale is the one the fast-sync report (reports/media/fast-sync-2026-10-26.html) costed, so the
# two reports agree; prices are Cloudflare's published ones (developers.cloudflare.com r2/pricing, workers/platform/
# pricing, durable-objects/platform/pricing; accessed 2026-10-26 for that report and unchanged on 2026-10-28).
COST_MODEL = {
    "people": 5,
    "devices_per_person": 3,
    "pages": 3,
    "changes_per_day": 2000,
    "page_open_hours_per_day": 8,
    "days": 30,
    "r2_class_a_per_m": 4.50, "r2_class_a_free_m": 1.0,
    "r2_class_b_per_m": 0.36, "r2_class_b_free_m": 10.0,
    "workers_paid_base": 5.00, "workers_req_per_m": 0.30, "workers_req_free_m": 10.0,
    "do_req_per_m": 0.15, "do_req_free_m": 1.0,
    # The hub's DO load is not observable in the local stack (the hub logs nothing); the fast-sync report's pessimistic
    # model (30 s heartbeats billed, 24 reconnects per socket per day, fan-out 4) is used and labelled modelled.
    "do_req_month_push": 151_000,
    # A page's re-read when it has no live socket (poll: every 10 s) or as the safety net (push: every 60 s):
    # one Worker request plus one class B read per host in the folder.
    "page_reread_s_poll": 10, "page_reread_s_push": 60,
}


def pctl(values, p):
    v = sorted(x for x in values if isinstance(x, (int, float)))
    if not v:
        return None
    rank = p / 100 * (len(v) - 1)
    lo, hi = int(rank), min(int(rank) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (rank - lo))


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def load(tag):
    trials, idle, ops = [], [], []
    for path in sorted(glob.glob(os.path.join(RAW, f"*-{tag}.jsonl"))):
        step = os.path.basename(path)[: -len(f"-{tag}.jsonl")]
        if not step.startswith(("fs-", "co-", "sw-")):
            continue
        for row in read_jsonl(path):
            row["_step"] = step
            trials.append(row)
        for row in read_jsonl(path[: -len(".jsonl")] + ".idle.jsonl"):
            row["_step"] = step
            idle.append(row)
        for row in read_jsonl(path[: -len(".jsonl")] + ".ops.jsonl"):
            row["_step"] = step
            ops.append(row)
    return trials, idle, ops


def label(row):
    """One series name: folder-sync's variant, a sweep point, or tool/variant."""
    if row["tool"] == "folder-sync":
        if row["_step"].startswith("sw-"):
            return "folder-sync " + row["_step"][3:]
        return f"folder-sync {row['variant']}"
    return f"{row['tool']} {row['variant']}"


def cells(trials):
    groups = {}
    for r in trials:
        key = (label(r), r["direction"], r.get("workload"), r.get("fault"))
        groups.setdefault(key, []).append(r)
    out = []
    for (series, direction, workload, fault), rows in sorted(groups.items(), key=lambda kv: [str(x) for x in kv[0]]):
        ok = [r for r in rows if r["status"] == "ok"]
        na = [r for r in rows if r["status"] == "n/a"]
        ms = [r["ms"] for r in ok]
        first = [r.get("first_ms") for r in ok if r.get("first_ms") is not None]
        out.append({
            "series": series, "tool": rows[0]["tool"], "variant": rows[0]["variant"], "step": rows[0]["_step"],
            "config": rows[0].get("config"), "direction": direction, "workload": workload, "fault": fault,
            "status": "n/a" if na and not ok else ("ok" if ok else "failed"),
            "note": (na[0].get("note") if na and not ok else None),
            "n": len(ok), "trials": len([r for r in rows if r["status"] != "n/a"]),
            "timeouts": sum(r["status"] == "timeout" for r in rows),
            "errors": sum(r["status"] == "error" for r in rows),
            "error_notes": sorted({(r.get("note") or "")[:160] for r in rows if r["status"] == "error"}),
            "p50": pctl(ms, 50), "p95": pctl(ms, 95), "min": min(ms) if ms else None, "max": max(ms) if ms else None,
            "first_p50": pctl(first, 50),
            "cold_read_p50": pctl([r.get("cold_read_ms") for r in ok if r.get("cold_read_ms") is not None], 50),
            "sha256_fail": sum(1 for r in rows if r["status"] == "ok" and r.get("sha256_ok") is False),
            "conflicts": sum(r.get("conflicts") or 0 for r in rows),
            "lost": sum(r.get("lost") or 0 for r in rows),
            "load1_p50": pctl([r.get("load1") for r in rows if r.get("load1") is not None], 50),
            "env": rows[0].get("env"), "real": all(r.get("real") for r in rows),
        })
    return out


def idle_by_series(idle):
    out = {}
    for r in idle:
        s = label(r)
        # the longest window wins (a push host's 60 s safety round only shows in a window longer than 60 s)
        if s not in out or r.get("window_s", 0) > out[s].get("window_s", 0):
            out[s] = r
    return out


def ops_by_series(ops):
    out = {}
    for r in ops:
        s = label(r)
        if r.get("workload") in ("1k", None) and r.get("direction") in ("m2m", "w2m"):
            out.setdefault(s, {})[r["direction"]] = r
    return out


def cost(series, idle_row, ops_rows):
    """$/month on Cloudflare at Zach's scale (COST_MODEL), from this series' measured request rates."""
    m = COST_MODEL
    if idle_row is None:
        return None
    tool = series.split(" ")[0]
    hosts = m["people"] * m["devices_per_person"]
    minutes = 60 * 24 * m["days"]
    req = idle_row.get("requests_per_min_per_host") or {}
    if tool in ("syncthing", "unison", "mutagen", "lsyncd"):
        return {"usd": 0.0, "usd_over_base": 0.0, "basis": "no cloud store: peer to peer, nothing on Cloudflare (and no web or agent copy)", "modelled": True}
    a = req.get("class_a", 0) * hosts * minutes
    b = req.get("class_b", 0) * hosts * minutes
    w = req.get("worker", 0) * hosts * minutes
    change = (ops_rows or {}).get("m2m")
    changes = m["changes_per_day"] * m["days"]
    if change:
        a += (change.get("class_a") or 0) * changes
        # WHY x (hosts-1): the measured change had one reader; at scale every other device reads it (pessimistic)
        b += (change.get("class_b") or 0) * (hosts - 1) * changes
        w += (change.get("worker") or 0) * changes
    do_req = 0
    if tool == "folder-sync":
        push = "poll" not in series
        reread_s = m["page_reread_s_push"] if push else m["page_reread_s_poll"]
        rereads = m["pages"] * m["page_open_hours_per_day"] * 3600 / reread_s * m["days"]
        w += rereads
        b += rereads * hosts
        # a page also re-reads on each change (push) — one Worker request + one read of the changed host's manifest
        if push:
            w += m["pages"] * changes
            b += m["pages"] * changes
            do_req = m["do_req_month_push"]
    usd_a = max(0, a / 1e6 - m["r2_class_a_free_m"]) * m["r2_class_a_per_m"]
    usd_b = max(0, b / 1e6 - m["r2_class_b_free_m"]) * m["r2_class_b_per_m"]
    base = m["workers_paid_base"] if tool == "folder-sync" else 0.0
    usd_w = max(0, w / 1e6 - m["workers_req_free_m"]) * m["workers_req_per_m"] if tool == "folder-sync" else 0.0
    usd_do = max(0, do_req / 1e6 - m["do_req_free_m"]) * m["do_req_per_m"]
    over = usd_a + usd_b + usd_w + usd_do
    return {
        "usd": round(base + over, 2), "usd_over_base": round(over, 2), "base": base,
        "class_a_m": round(a / 1e6, 3), "class_b_m": round(b / 1e6, 3), "worker_m": round(w / 1e6, 3), "do_req_m": round(do_req / 1e6, 3),
        "basis": f"measured idle requests/min/host ({idle_row.get('window_s')} s window) x {hosts} devices + measured per-change requests x {m['changes_per_day']}/day (reads x {hosts - 1} devices) + modelled pages/DO",
        "modelled": True,
    }


def frontier(points):
    """Non-dominated points (lower cost and lower latency both better)."""
    keep = []
    for p in points:
        if p["x"] is None or p["y"] is None:
            continue
        dominated = any(q is not p and q["x"] is not None and q["y"] is not None and q["x"] <= p["x"] and q["y"] <= p["y"] and (q["x"] < p["x"] or q["y"] < p["y"]) for q in points)
        if not dominated:
            keep.append(p["series"])
    return keep


def headline_cell(cells_, series, direction):
    """The 1 KB cell (offline: the drop fault) — the KPI's workload."""
    for c in cells_:
        if c["series"] != series or c["direction"] != direction:
            continue
        if direction == "offline" and c["fault"] == "drop":
            return c
        if direction != "offline" and c["workload"] == "1k":
            return c
    return None


# WHY Mutagen is outside "networked": its local alpha->beta session is one daemon moving files between two local paths,
# with no network hop at all, so it is a floor for this machine's disk, not a competitor on the same problem.
NOT_NETWORKED = {"mutagen"}


def best_competitor(cells_, direction, networked_only=True):
    best = None
    for c in cells_:
        if c["tool"] == "folder-sync" or c["status"] != "ok" or c["p50"] is None:
            continue
        if networked_only and c["tool"] in NOT_NETWORKED:
            continue
        if direction == "offline":
            if c["direction"] != "offline" or c["fault"] != "drop":
                continue
        elif c["direction"] != direction or c["workload"] != "1k":
            continue
        if c["timeouts"] or c["sha256_fail"] or c["lost"]:
            continue  # a tool that lost or corrupted a write in this cell is not "best"
        if best is None or c["p50"] < best["p50"]:
            best = c
    return best


def sweep_table(cells_, idle, costs):
    rows = {}
    for c in cells_:
        if not c["step"].startswith("sw-") and c["series"] not in ("folder-sync push", "folder-sync poll"):
            continue
        r = rows.setdefault(c["series"], {"series": c["series"], "config": c["config"], "correct": True})
        key = f"{c['direction']}_{c['workload'] or ''}_{c['fault'] or ''}".strip("_").replace("__", "_")
        r[key] = c["p50"]
        r[key + "_p95"] = c["p95"]
        if c["conflicts"] or c["lost"] or c["sha256_fail"] or c["timeouts"]:
            r["correct"] = False
    for s, r in rows.items():
        i = idle.get(s)
        r["idle_cpu_pct"] = i.get("cpu_pct_per_host") if i else None
        r["idle_wakeups_min"] = i.get("wakeups_per_min_per_host") if i else None
        r["idle_window_s"] = i.get("window_s") if i else None
        r["usd_month"] = (costs.get(s) or {}).get("usd")
    return sorted(rows.values(), key=lambda r: r["series"])


def stamp(dt):
    return dt.astimezone().isoformat(timespec="seconds")


def catalog(generated):
    lines = {"lines_by": "variant", "line_values": ["head", "push", "tuned", "poll"]}
    how = ("bench/fast (PEP 0008) in /home/bam/folder-sync, branch lane/sync-bench: two machines + a web host + an agent on "
           "loopback (rclone serve s3 + the R2 stand-in + wrangler dev), each machine behind its own TCP proxy; 1 KB file, "
           "10 trials at random phases. Headline = head (claude/folder-sync-v0 as it is now); push = lane/fast-sync; "
           "tuned = push with debounce 50 ms, a 1 s hub reconnect cap and a 300 s safety poll (the sweep's best that meets the cost and idle-CPU bounds); poll = v0 before push.")
    kpis = []
    for d in DIRECTIONS:
        unit_note = " (clock starts when the network comes back)" if d == "offline" else ""
        kpis.append({"id": f"ffs_{d}_p50_ms", "title": f"{DIRECTION_TITLES[d].capitalize()} (p50)", "level": 0, "parent": None,
                     "unit": "ms", "direction": "lower", "computed_from": "runs", "scale": "log", **lines,
                     "description": f"End-to-end latency, {DIRECTION_TITLES[d]}{unit_note}, until the reader holds the same sha256. {how}",
                     "formula": "p50 over the run's trials (linear between ranks)"})
        kpis.append({"id": f"ffs_{d}_p95_ms", "title": f"{DIRECTION_TITLES[d].capitalize()} (p95)", "level": 1, "parent": f"ffs_{d}_p50_ms",
                     "unit": "ms", "direction": "lower", "computed_from": "runs", "scale": "log", **lines,
                     "description": f"The slow tail of ffs_{d}_p50_ms.", "formula": "p95 over the same trials"})
    for d in DIRECTIONS:
        kpis.append({"id": f"ffs_ratio_{d}", "title": f"Competitiveness, {DIRECTION_TITLES[d]}", "level": 1, "parent": "ffs_competitiveness",
                     "unit": "x", "direction": "lower", "computed_from": "runs", "scale": "log", "target": 1.0, **lines,
                     "description": ("folder-sync's p50 divided by the best off-the-shelf tool's p50 on the same workload and machine "
                                     "(Syncthing, Unison, rclone bisync, lsyncd; Mutagen's local-only session is excluded: it has no network hop). "
                                     "1.0 = parity, below 1 = folder-sync is faster. Null when no off-the-shelf tool has this direction."),
                     "formula": "p50(folder-sync variant) / min p50(off-the-shelf, networked, no lost or corrupted write)"})
    kpis.insert(0, {"id": "ffs_competitiveness", "title": "Competitiveness (worst direction)", "level": 0, "parent": None, "unit": "x",
                    "direction": "lower", "computed_from": "runs", "scale": "log", "target": 1.0, **lines,
                    "description": "The worst (largest) of the per-direction ratios that have a competitor: 1.0 means folder-sync is at least as fast as the best off-the-shelf tool everywhere.",
                    "formula": "max over directions of ffs_ratio_<direction>"})
    kpis.append({"id": "ffs_cost_usd_month", "title": "Cloudflare $/month at Zach's scale", "level": 0, "parent": None, "unit": "USD",
                 "direction": "lower", "computed_from": "runs", "scale": "linear", **lines,
                 "description": ("Modelled from measured request rates: 5 people x 3 devices + 3 pages, 2,000 changes/day; R2, Workers and "
                                 "Durable Objects list prices; includes the $5 Workers Paid plan. Idle and per-change requests are measured "
                                 "on the local stack; the hub's DO requests are the fast-sync report's pessimistic model."),
                 "formula": "base $5 + overage of (idle req/min/host x 15 x 43,200) + (per-change req x 60,000, reads x 14) + pages + DO"})
    kpis.append({"id": "ffs_idle_cpu_pct", "title": "Idle CPU per machine", "level": 1, "parent": "ffs_cost_usd_month", "unit": "% of a core",
                 "direction": "lower", "computed_from": "runs", "scale": "log", **lines,
                 "description": "The machine's whole process tree (daemon + every rclone it spawns), from its cgroup, over a 120 s idle window.",
                 "formula": "delta cpu.stat usage_usec / window"})
    return {
        "schema": "vt-kpi-catalog/1", "generated_at": generated, "unit_of_iteration": "run",
        "title": "Fast Folder Sync: latency per direction vs off-the-shelf, subject to cost",
        "producer": {"name": "folder-sync bench/fast/analyse.py (rows from fs_bench.mjs + competitors/bench_competitors.py)",
                     "bench_version": BENCH_VERSION, "repo": "/home/bam/folder-sync", "doc": "docs/peps/0008-fast-folder-sync-bench.md"},
        "kpis": kpis,
    }


def variant_of(series):
    s = series.replace("folder-sync ", "")
    return {"push-optimal": "tuned"}.get(s, s)


def kpi_points(summary, t, run_id, code):
    out = []
    source = {"code_sha": code, "bench_version": BENCH_VERSION, "run_ids": [run_id], "dirty": False}
    for v in summary["folder_sync_variants"]:
        vv = variant_of(v)
        if vv not in ("head", "push", "tuned", "poll"):
            continue
        # WHY the short name: headline is keyed "head"/"push"/…, the series list carries "folder-sync head"
        per = summary["headline"].get(v.replace("folder-sync ", ""), {})
        values = {}
        for d in DIRECTIONS:
            h = per.get(d) or {}
            values[f"ffs_{d}_p50_ms"] = (h.get("p50"), h.get("n"))
            values[f"ffs_{d}_p95_ms"] = (h.get("p95"), h.get("n"))
            values[f"ffs_ratio_{d}"] = (h.get("ratio"), h.get("n"))
        ratios = [h.get("ratio") for h in per.values() if h.get("ratio") is not None]
        values["ffs_competitiveness"] = (round(max(ratios), 2) if ratios else None, len(ratios))
        c = summary["cost"].get(v) or {}
        values["ffs_cost_usd_month"] = (c.get("usd"), 1)
        i = summary["idle"].get(v) or {}
        values["ffs_idle_cpu_pct"] = (i.get("cpu_pct_per_host"), 1)
        for kpi, (value, n) in values.items():
            base = {"schema": "vt-kpi-point/1", "kpi": kpi, "t": t, "value": value, "n": n,
                    "status": "measured" if value is not None else "not_measured",
                    "labels": {"variant": vv, "env": "local-loopback", "host": socket.gethostname()}, "source": source}
            out.append({**base, "slice": {"variant": vv}})
            if vv == "head":
                out.append(base)  # the headline: the deployed branch as it is now
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--no-kpi", action="store_true")
    ap.add_argument("--out", default=os.path.expanduser("~/vt/zach/producers/folder-sync-bench"))
    a = ap.parse_args()

    trials, idle_rows, ops_rows = load(a.tag)
    if not trials:
        raise SystemExit(f"no rows for tag {a.tag} in {RAW}")
    cs = cells(trials)
    idle = idle_by_series(idle_rows)
    ops = ops_by_series(ops_rows)
    series_all = sorted({c["series"] for c in cs})
    costs = {s: cost(s, idle.get(s), ops.get(s)) for s in series_all}

    # the headline per folder-sync series and direction, with its competitiveness ratio
    best = {d: best_competitor(cs, d) for d in DIRECTIONS}
    best_any = {d: best_competitor(cs, d, networked_only=False) for d in DIRECTIONS}
    fs_series = [s for s in series_all if s.startswith("folder-sync")]
    headline = {}
    for s in fs_series:
        headline[s.replace("folder-sync ", "")] = {}
        for d in DIRECTIONS:
            c = headline_cell(cs, s, d)
            if not c:
                continue
            b = best[d]
            ratio = round(c["p50"] / b["p50"], 2) if (c["p50"] is not None and b and b["p50"]) else None
            headline[s.replace("folder-sync ", "")][d] = {"p50": c["p50"], "p95": c["p95"], "n": c["n"], "ratio": ratio,
                                                          "vs": b["series"] if b else None}

    # the frontier: per direction, latency (1 KB p50) against $/month and against idle CPU
    pareto = {}
    for d in DIRECTIONS:
        pts = []
        for s in series_all:
            if s.startswith("folder-sync") and s.replace("folder-sync ", "") not in ("poll", "push", "head", "push-optimal"):
                continue
            c = headline_cell(cs, s, d)
            if not c or c["p50"] is None:
                continue
            i = idle.get(s) or {}
            pts.append({"series": s, "y": c["p50"], "p95": c["p95"], "x": (costs.get(s) or {}).get("usd"),
                        "cpu": i.get("cpu_pct_per_host"), "correct": not (c["conflicts"] or c["lost"] or c["sha256_fail"] or c["timeouts"])})
        pareto[d] = {"points": pts, "frontier_cost": frontier(pts),
                     "frontier_cpu": frontier([{**p, "x": p["cpu"]} for p in pts])}

    # ranks: folder-sync's place among every tool with that direction (1 KB p50)
    ranks = {}
    for d in DIRECTIONS:
        pts = sorted((p for p in pareto[d]["points"] if p["correct"]), key=lambda p: p["y"])
        ranks[d] = [{"series": p["series"], "p50": p["y"]} for p in pts]

    sweep = sweep_table(cs, idle, costs)
    code = subprocess.run(["git", "-C", HERE, "rev-parse", "--short=12", "HEAD"], capture_output=True, text=True).stdout.strip()
    summary = {
        "schema": "fast-folder-sync-summary/1", "tag": a.tag, "generated": stamp(datetime.now(timezone.utc)), "bench_code": code,
        "cells": cs, "idle": {k.replace("folder-sync ", ""): v for k, v in idle.items()} | {k: v for k, v in idle.items()},
        "cost": {k.replace("folder-sync ", ""): v for k, v in costs.items()} | costs,
        "cost_model": COST_MODEL, "headline": headline, "best_competitor": best, "best_any": best_any,
        "pareto": pareto, "ranks": ranks, "sweep": sweep, "folder_sync_variants": fs_series,
    }
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    out_path = os.path.join(HERE, "results", f"summary-{a.tag}.json")
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=1, default=str)
    print(out_path)

    if not a.no_kpi:
        # WHY a guard: a lookup bug once wrote every latency KPI as null while cost and CPU looked fine; a run whose
        # measured head cells are all null must fail loudly, never land in Vibe Tracks
        points = kpi_points(summary, "check", "check", code)
        lat = [p for p in points if p["kpi"].endswith("_p50_ms") and p["labels"]["variant"] == "head" and "slice" not in p]
        if lat and all(p["value"] is None for p in lat) and any(c["series"] == "folder-sync head" and c["n"] for c in cs):
            raise SystemExit("refusing to write KPIs: every head latency point is null although head cells were measured")
        os.makedirs(a.out, exist_ok=True)
        t = stamp(datetime.now(timezone.utc))
        run_id = f"ffs-{a.tag}-{code}"
        tmp = os.path.join(a.out, f".kpi_catalog.json.{os.getpid()}")
        with open(tmp, "w") as f:
            json.dump(catalog(t), f, indent=1)
            f.write("\n")
        os.replace(tmp, os.path.join(a.out, "kpi_catalog.json"))
        with open(os.path.join(a.out, "kpi_series.jsonl"), "a") as f:
            for p in kpi_points(summary, t, run_id, code):
                f.write(json.dumps(p) + "\n")
        with open(os.path.join(a.out, "runs_table.jsonl"), "a") as f:
            f.write(json.dumps({"schema": "vt-run/1", "run_id": run_id, "t": t,
                                "facets": {"tag": a.tag, "code_sha": code, "host": socket.gethostname(), "env": "local-loopback"},
                                "metrics": {f"{v}_{d}_p50_ms": (headline[v].get(d) or {}).get("p50") for v in headline for d in DIRECTIONS}}) + "\n")
        print(f"kpi: {a.out} ({run_id})")

    for d in DIRECTIONS:
        b = best[d]
        print(f"{d:8s} best off-the-shelf: {b['series'] + ' ' + str(b['p50']) + ' ms' if b else 'none'} | " +
              " | ".join(f"{v} {h[d]['p50']} ms (x{h[d]['ratio']})" for v, h in headline.items() if d in h))


if __name__ == "__main__":
    main()
