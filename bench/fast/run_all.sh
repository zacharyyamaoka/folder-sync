#!/usr/bin/env bash
# The whole Fast Folder Sync bench (PEP 0008), one run at a time so no two tools share the CPU:
# folder-sync (poll, push, head), every off-the-shelf tool, then the tunables sweep, then the analysis + KPIs.
#
#   systemd-run --user --scope -p MemoryMax=16G -- bash /home/bam/folder-sync/.claude/worktrees/bench/bench/fast/run_all.sh [TAG] [PHASES]
#
# TAG defaults to today's date (rows: bench/fast/results/raw/<step>-<TAG>*.jsonl). PHASES is a comma list of
# base,competitors,sweep,analyse (default: all). A step that fails is logged and the next one runs.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-$(date +%Y%m%d)}"
PHASES="${2:-base,competitors,sweep,analyse}"
LOG="$HERE/results/raw/run_all-$TAG.log"
mkdir -p "$HERE/results/raw"
FS="node $HERE/fs_bench.mjs run"
CO="python3 $HERE/competitors/bench_competitors.py run"
SMALL="1k,100k,many100,storm"

step() {
	local id="$1"; shift
	if [ -s "$HERE/results/raw/$id-$TAG.jsonl" ] && [ -z "${FORCE:-}" ]; then
		echo "[$(date +%T)] skip $id (rows exist)" | tee -a "$LOG"; return
	fi
	echo "[$(date +%T)] start $id load=$(cut -d' ' -f1 /proc/loadavg): $*" | tee -a "$LOG"
	"$@" --run-id "$id-$TAG" >>"$LOG" 2>&1
	echo "[$(date +%T)] end $id exit=$?" | tee -a "$LOG"
}

has() { [[ ",$PHASES," == *",$1,"* ]]; }

if has base; then
	for v in poll push head; do
		step "fs-$v-small" $FS --variant "$v" --directions m2m,m2w,w2m,m2a,offline --workloads "$SMALL" --faults drop,sleep --trials 10 --idle-s 120
		step "fs-$v-10m" $FS --variant "$v" --directions m2m,m2w,w2m,m2a --workloads 10m --trials 5 --idle-s 0
		step "fs-$v-200m" $FS --variant "$v" --directions m2m,m2w,w2m --workloads 200m --trials 3 --idle-s 0
	done
fi

if has competitors; then
	for t in syncthing unison mutagen rclone-bisync lsyncd; do
		step "co-$t-small" $CO --tool "$t" --directions m2m,m2w,w2m,m2a,offline --workloads "$SMALL" --faults drop,sleep --trials 10 --idle-s 120
		step "co-$t-10m" $CO --tool "$t" --directions m2m,m2w,w2m,m2a --workloads 10m --trials 5 --idle-s 0
		step "co-$t-200m" $CO --tool "$t" --directions m2m,m2w,w2m --workloads 200m --trials 3 --idle-s 0
	done
fi

if has sweep; then
	# One tunable at a time around the push defaults (debounce 100ms, backoff_max 30s, fallback 60s); poll's interval.
	for d in 0ms 25ms 50ms 250ms; do
		[ "$d" = 0ms ] && d=1ms
		step "sw-push-debounce-$d" $FS --variant push --config "debounce=$d" --directions m2m,m2w,w2m --workloads 1k,many100,storm --trials 8 --idle-s 60
	done
	for b in 1s 2s 5s; do
		step "sw-push-backoff-$b" $FS --variant push --config "backoff_max=$b" --directions offline --faults drop --trials 6 --idle-s 0
	done
	step "sw-push-backoff-30s" $FS --variant push --directions offline --faults drop --trials 6 --idle-s 0
	for f in 15s 300s; do
		step "sw-push-fallback-$f" $FS --variant push --config "fallback=$f" --directions m2m --workloads 1k --trials 3 --idle-s 330
	done
	for i in 1s 2s 5s; do
		step "sw-poll-interval-$i" $FS --variant poll --config "interval=$i" --directions m2m,m2w,w2m --workloads 1k,storm --trials 8 --idle-s 120
	done
	step "sw-push-best" $FS --variant push --config "debounce=25ms,backoff_max=2s" --directions m2m,m2w,w2m,m2a,offline --workloads "$SMALL" --faults drop,sleep --trials 10 --idle-s 120
fi

if has analyse; then
	echo "[$(date +%T)] analyse" | tee -a "$LOG"
	python3 "$HERE/analyse.py" --tag "$TAG" >>"$LOG" 2>&1
	echo "[$(date +%T)] analyse exit=$?" | tee -a "$LOG"
fi
echo "[$(date +%T)] all done" | tee -a "$LOG"
