#!/usr/bin/env python3
"""One rclone-bisync "host daemon" for the Fast Folder Sync bench (bench/fast/CONTRACT.md).

rclone has no watcher for bisync, so the honest default is a loop: run `rclone bisync …`, sleep --interval seconds,
repeat. Each run is a child of this process, so it stays inside the host's systemd scope (its CPU is counted there);
the children's context switches come from os.wait4's rusage and are written to --stats after every run, because a
child that has exited is no longer visible in /proc.

    python3 -I bisync_loop.py --interval 2 --stats stats.json -- /path/rclone --config c bisync A s3:bucket/p …
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=float, required=True, help="seconds to sleep between runs")
    parser.add_argument("--stats", required=True, help="JSON file rewritten after every run")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    stats = {"runs": 0, "failures": 0, "nvcsw": 0, "nivcsw": 0, "last_rc": None, "last_end": None}
    child = None

    def stop(signum, frame):
        if child is not None and child.poll() is None:
            child.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while True:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
        _, status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        stats["runs"] += 1
        stats["failures"] += child.returncode != 0
        stats["nvcsw"] += usage.ru_nvcsw
        stats["nivcsw"] += usage.ru_nivcsw
        stats["last_rc"] = child.returncode
        stats["last_end"] = time.time()
        with open(args.stats + ".tmp", "w") as out:
            json.dump(stats, out)
        os.replace(args.stats + ".tmp", args.stats)
        child = None
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
