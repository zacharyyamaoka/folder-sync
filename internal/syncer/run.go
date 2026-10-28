package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/layout"
	"folder-sync/internal/names"
)

// LastSyncSchema names last-sync.json.
const LastSyncSchema = "folder-sync-last-sync/1"

// LastSync is projects/<key>/last-sync.json, what `status` shows.
type LastSync struct {
	Schema         string          `json:"schema"`
	Project        string          `json:"project"`
	Bucket         string          `json:"bucket"`
	Folder         string          `json:"folder"`
	Root           string          `json:"root"`
	HostID         string          `json:"host_id"`
	HostName       string          `json:"host_name"`
	RoundStarted   string          `json:"round_started"`
	RoundFinished  string          `json:"round_finished"`
	OK             bool            `json:"ok"`
	Error          string          `json:"error,omitempty"`
	LastPush       string          `json:"last_push,omitempty"`
	LastPull       string          `json:"last_pull,omitempty"`
	LastCleanRun   string          `json:"last_clean_run,omitempty"`
	LastReconcile  string          `json:"last_reconcile,omitempty"`
	LastDiscover   string          `json:"last_discover,omitempty"`
	Uploaded       int             `json:"uploaded"`
	Deleted        int             `json:"deleted"`
	Fetched        int             `json:"fetched"`
	RemovedCopies  int             `json:"removed_copies"`
	HeldDeletes    []string        `json:"held_deletes"`
	Skipped        []names.Skipped `json:"skipped"`
	Conflicts      []Conflict      `json:"conflicts"`
	Peers          []PeerResult    `json:"peers"`
	ManifestWrites int             `json:"manifest_writes"`
}

// LoadLastSync reads a state dir's last-sync.json.
func LoadLastSync(stateDir string) (LastSync, error) {
	var last LastSync
	data, err := os.ReadFile(filepath.Join(stateDir, "last-sync.json"))
	if err != nil {
		return last, err
	}
	return last, json.Unmarshal(data, &last)
}

// DiscoverEvery is how often a round looks for new peers between reconciles.
// WHY not every round: the PEP's cost model (docs/peps/0001 §4) never lists the
// remote on every round; a delimiter LIST every 5 minutes on 5 machines is about
// 43,000 Class A operations a month, inside R2's free million.
const DiscoverEvery = 5 * time.Minute

// due reports whether stamp is older than every (or missing).
func due(stamp string, every time.Duration, now time.Time) bool {
	t, err := time.Parse(time.RFC3339Nano, stamp)
	return err != nil || now.Sub(t) >= every
}

// ReconcileDue reports whether the hourly reconcile should run now.
func ReconcileDue(last LastSync, now time.Time) bool {
	return due(last.LastReconcile, ReconcileEvery, now)
}

// Options steer one round.
type Options struct {
	PushOnly       bool // publish: bring the manifest up to date, skip the pull
	ForceReconcile bool // sync --watch: reconcile at start
	// ForceDiscover looks for new peers this round (one delimiter LIST) instead of waiting for DiscoverEvery.
	// WHY: an app's "sync now" (vt sync now) should find a machine that joined a minute ago, not in 5 minutes.
	ForceDiscover bool
	// Restore is a restore of this machine's own files to carry out in this round, after its push (folder-sync
	// restore); its outcome is Result.Restore.
	Restore *history.Request
}

// Round runs one round: (reconcile if due), push, the restores it is asked for, pull, then the round's change and
// pull records, (the daily prune), and last-sync.json.
// WHY restore requests are looked for only with peer discovery (a reconcile, --discover, or every 5 minutes), not at
// the start of every `sync --once`: a round with no changes makes no listing (docs/peps/0001 §4), and a `sync --once`
// run less often than every 5 minutes discovers on every run anyway. Local requests are a folder read: every round.
func (p *Project) Round(ctx context.Context, opts Options) (Result, error) {
	lock, err := p.AcquireLock()
	if err != nil {
		return Result{}, err
	}
	defer lock.Release()

	started := p.Now()
	stamp := Stamp(started)
	last, _ := LoadLastSync(p.StateDir)
	last.Schema = LastSyncSchema
	last.Project, last.Bucket, last.Folder, last.Root = p.Config.Project, p.Config.Bucket, p.Folder, p.Root
	last.HostID, last.HostName = p.Host.ID, p.Host.Name
	p.prevRoundStart, _ = time.Parse(time.RFC3339Nano, last.RoundStarted)
	wasSynced := last.OK && last.LastCleanRun != "" && last.LastCleanRun == last.RoundFinished
	last.RoundStarted = started.UTC().Format(time.RFC3339Nano)
	p.reportedSkips = map[string]bool{}
	p.behind = false
	for _, s := range last.Skipped {
		p.reportedSkips[s.Path] = true
	}

	var result Result
	runErr := func() error {
		step := time.Now()
		if err := p.refreshCreds(); err != nil {
			return err
		}
		p.Trace.Since("step", step, map[string]any{"name": "creds"})
		step = time.Now()
		// WHY no reconcile with read-only keys (review r2 #7): it moves strays to the trash, a write; peers are still
		// looked for, so the pull below finds them
		reconcile := opts.ForceReconcile || ReconcileDue(last, started) || p.reconcileRequested()
		discovered := false
		if reconcile && !p.Creds.ReadOnly {
			if err := p.Reconcile(ctx, stamp, &result); err != nil {
				return fmt.Errorf("reconcile: %w", err)
			}
			last.LastReconcile = p.Now().UTC().Format(time.RFC3339Nano)
			last.LastDiscover = last.LastReconcile
			discovered = true
		} else if reconcile || opts.ForceDiscover || due(last.LastDiscover, DiscoverEvery, started) {
			if reconcile && p.Creds.ReadOnly {
				if err := p.ReconcileReadOnly(); err != nil {
					return fmt.Errorf("reconcile (read-only): %w", err)
				}
			}
			if err := p.Discover(ctx); err != nil {
				return fmt.Errorf("discover peers: %w", err)
			}
			last.LastDiscover = p.Now().UTC().Format(time.RFC3339Nano)
			discovered = true
			p.Trace.Since("step", step, map[string]any{"name": "discover"})
		}
		// restore requests (read-only keys can write nothing, so they wait)
		var requests []pendingRequest
		if !p.Creds.ReadOnly {
			requests = p.localRequests()
			if discovered {
				asked, err := p.bucketRequests()
				if err != nil {
					p.say("restore requests: %v (looked for again with the next peer scan)", p.Creds.Scrub(err.Error()))
				}
				requests = append(requests, asked...)
			}
		}
		// WHY an empty folder still pulls (review r1 #6): the refusal guards this machine's files in the bucket, not
		// its copies of the others'; an edit on another machine or the web must still arrive. The round still
		// fails with the refusal, so `status` and the watch loop show it.
		// and so does a push whose read-only keys (over quota) held its uploads (review r2 #7)
		var refused error
		var empty *EmptyFolderError
		var readOnly *ReadOnlyError
		var copyFailed *CopyError // a history copy that failed held its path: the others went, and the round pulls
		step = time.Now()
		if err := p.Push(ctx, stamp, &result); errors.As(err, &empty) || errors.As(err, &readOnly) || errors.As(err, &copyFailed) {
			refused = fmt.Errorf("push: %w", err)
		} else if err != nil {
			return fmt.Errorf("push: %w", err)
		} else {
			last.LastPush = p.Now().UTC().Format(time.RFC3339Nano)
		}
		p.Trace.Since("step", step, map[string]any{"name": "push", "uploaded": len(result.Uploaded), "deleted": len(result.Deleted), "manifest": result.ManifestWritten})
		// WHY no restore after a refused push: a restore first publishes what is on disk, and this round could not
		if refused == nil {
			for _, pr := range requests {
				p.applyRequest(ctx, stamp, pr, &result)
			}
			if opts.Restore != nil {
				outcome := p.applyRequest(ctx, stamp, pendingRequest{req: *opts.Restore}, &result)
				result.Restore = &outcome
			}
		} else if opts.Restore != nil {
			return refused
		}
		// the change records go while the pull runs: readers wait on the manifest, never on its record
		flushed := make(chan error, 1)
		go func() { flushed <- p.FlushRecords() }()
		defer func() {
			if err := <-flushed; err != nil {
				p.say("change records: %v (sent again next round)", p.Creds.Scrub(err.Error()))
			}
		}()
		step = time.Now()
		if opts.PushOnly {
			return refused
		}
		pullErr := p.Pull(ctx, &result)
		if err := p.queuePulls(result.Events, p.Now()); err != nil {
			p.say("the pull record: %v", err)
		}
		if pullErr != nil {
			return errors.Join(refused, fmt.Errorf("pull: %w", pullErr))
		}
		last.LastPull = p.Now().UTC().Format(time.RFC3339Nano)
		fetchedFiles := 0
		for _, peer := range result.Peers {
			fetchedFiles += peer.Fetched
		}
		p.Trace.Since("step", step, map[string]any{"name": "pull", "peers": len(result.Peers), "fetched": fetchedFiles})
		return refused
	}()

	// the pull record, and anything the flush above could not send
	if err := p.FlushRecords(); err != nil && runErr == nil {
		p.say("change records: %v (sent again next round)", p.Creds.Scrub(err.Error()))
	}
	if result.Reconciled && runErr == nil && p.pruneDue(p.Now()) {
		if _, err := p.Prune(); err != nil {
			p.say("prune: %v (tried again with the next reconcile)", p.Creds.Scrub(err.Error()))
		}
	}

	finished := p.Now()
	p.Trace.Event("round", map[string]any{"start": started.UnixMilli(), "ms": finished.Sub(started).Milliseconds(), "ok": runErr == nil})
	last.RoundFinished = finished.UTC().Format(time.RFC3339Nano)
	last.OK = runErr == nil
	last.Error = ""
	if runErr != nil {
		last.Error = p.Creds.Scrub(runErr.Error())
	}
	last.Uploaded, last.Deleted = len(result.Uploaded), len(result.Deleted)
	last.Fetched, last.RemovedCopies = 0, 0
	for _, peer := range result.Peers {
		last.Fetched += peer.Fetched
		last.RemovedCopies += peer.Removed
	}
	last.HeldDeletes = nonNil(result.HeldDeletes)
	last.Skipped = result.Skipped
	if last.Skipped == nil {
		last.Skipped = []names.Skipped{}
	}
	last.Conflicts = append(last.Conflicts, result.Conflicts...)
	if len(last.Conflicts) > 50 {
		last.Conflicts = last.Conflicts[len(last.Conflicts)-50:]
	}
	if last.Conflicts == nil {
		last.Conflicts = []Conflict{}
	}
	if !opts.PushOnly {
		last.Peers = result.Peers
	}
	if last.Peers == nil {
		last.Peers = []PeerResult{}
	}
	if result.ManifestWritten {
		last.ManifestWrites++
	}
	if runErr == nil && len(result.Skipped) == 0 && len(result.HeldDeletes) == 0 && len(result.Conflicts) == 0 {
		last.LastCleanRun = last.RoundFinished
		// synced: a clean round, nothing local pending, every known peer's latest manifest applied. Said when it
		// becomes true, and after a round that moved something, not on every quiet round.
		moved := len(result.Uploaded)+len(result.Deleted)+last.Fetched+last.RemovedCopies > 0
		if !p.behind && (moved || !wasSynced) {
			result.Events = append(result.Events, p.fileEvent("synced", finished))
		}
	}
	if err := writeJSON(filepath.Join(p.StateDir, "last-sync.json"), last); err != nil && runErr == nil {
		runErr = err
	}
	p.logf("round ok=%v uploaded=%d deleted=%d held=%d fetched=%d removed=%d skipped=%d conflicts=%d reconciled=%v manifest=%v took=%s err=%v",
		last.OK, last.Uploaded, last.Deleted, len(result.HeldDeletes), last.Fetched, last.RemovedCopies,
		len(result.Skipped), len(result.Conflicts), result.Reconciled, result.ManifestWritten,
		finished.Sub(started).Round(time.Millisecond), runErr)
	return result, runErr
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// AllStates lists every registered project on this machine with its last round.
func AllStates(l layout.Layout) ([]Registration, []LastSync) {
	entries, _ := os.ReadDir(l.Projects)
	var regs []Registration
	var lasts []LastSync
	for _, entry := range entries {
		dir := filepath.Join(l.Projects, entry.Name())
		reg, err := ReadRegistration(dir)
		if err != nil {
			continue
		}
		last, _ := LoadLastSync(dir)
		regs = append(regs, reg)
		lasts = append(lasts, last)
	}
	order := make([]int, len(regs))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool { return regs[order[a]].Folder < regs[order[b]].Folder })
	sortedRegs := make([]Registration, len(regs))
	sortedLasts := make([]LastSync, len(regs))
	for i, j := range order {
		sortedRegs[i], sortedLasts[i] = regs[j], lasts[j]
	}
	return sortedRegs, sortedLasts
}
