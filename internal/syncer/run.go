package syncer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

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
}

// Round runs one round: (reconcile if due), push, pull, then writes last-sync.json.
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
	last.Project, last.Bucket, last.Folder = p.Config.Project, p.Config.Bucket, p.Folder
	last.HostID, last.HostName = p.Host.ID, p.Host.Name
	last.RoundStarted = started.UTC().Format(time.RFC3339Nano)

	var result Result
	runErr := func() error {
		if opts.ForceReconcile || ReconcileDue(last, started) {
			if err := p.Reconcile(ctx, stamp, &result); err != nil {
				return fmt.Errorf("reconcile: %w", err)
			}
			last.LastReconcile = p.Now().UTC().Format(time.RFC3339Nano)
			last.LastDiscover = last.LastReconcile
		} else if due(last.LastDiscover, DiscoverEvery, started) {
			if err := p.Discover(ctx); err != nil {
				return fmt.Errorf("discover peers: %w", err)
			}
			last.LastDiscover = p.Now().UTC().Format(time.RFC3339Nano)
		}
		if err := p.Push(ctx, stamp, &result); err != nil {
			return fmt.Errorf("push: %w", err)
		}
		last.LastPush = p.Now().UTC().Format(time.RFC3339Nano)
		if opts.PushOnly {
			return nil
		}
		if err := p.Pull(ctx, &result); err != nil {
			return fmt.Errorf("pull: %w", err)
		}
		last.LastPull = p.Now().UTC().Format(time.RFC3339Nano)
		return nil
	}()

	finished := p.Now()
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
