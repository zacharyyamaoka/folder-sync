// Package push is the machine side of PEP 0004: a folder watcher and the folder hub's client. Both only say "run a
// round now"; the round, the manifest and the bucket are unchanged, so a missed signal costs one fallback interval,
// never data.
package push

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Debounce is how long the folder must be quiet before a change is signalled.
// WHY 100 ms: an editor's save (write temp, rename, chmod) and an agent writing several files are each a burst of
// events; one round per burst, started within a tenth of a second, is what "instant" needs.
const Debounce = 100 * time.Millisecond

// Watcher signals on Changed when anything this machine publishes changed.
type Watcher struct {
	Changed <-chan struct{}
	folder  string
	peers   string
	inner   *fsnotify.Watcher
	healthy atomic.Bool
	done    chan struct{}
}

// Ignored reports whether a path (relative to the folder, slash-separated) never needs a round: the peers' copies
// (written by this machine's own pulls), folder-sync's config, its own dot-dirs, and editor temp files.
func Ignored(rel, peersDir string) bool {
	rel = filepath.ToSlash(rel)
	if rel == "." || rel == "" {
		return false
	}
	first, _, _ := strings.Cut(rel, "/")
	if first == peersDir || first == ".folder-sync.toml" || strings.HasPrefix(first, ".folder-sync") {
		return true
	}
	base := rel[strings.LastIndex(rel, "/")+1:]
	return strings.HasSuffix(base, "~") || strings.HasSuffix(base, ".swp") || strings.HasSuffix(base, ".tmp")
}

// Watch starts watching folder recursively. It never fails the caller's sync: on any error it returns a Watcher
// that is not Healthy, and the caller keeps polling at its normal interval.
func Watch(folder, peersDir string) *Watcher {
	changed := make(chan struct{}, 1)
	w := &Watcher{Changed: changed, folder: folder, peers: peersDir, done: make(chan struct{})}
	inner, err := fsnotify.NewWatcher()
	if err != nil {
		return w
	}
	w.inner = inner
	if err := w.addTree(folder); err != nil {
		// WHY unhealthy and not fatal: inotify's max_user_watches (or a permissions error) may stop a big tree;
		// polling still syncs it
		inner.Close()
		w.inner = nil
		return w
	}
	w.healthy.Store(true)
	go w.run(changed)
	return w
}

// Healthy reports whether the watcher covers the whole folder.
func (w *Watcher) Healthy() bool { return w != nil && w.healthy.Load() }

// Close stops the watcher.
func (w *Watcher) Close() {
	if w == nil || w.inner == nil {
		return
	}
	w.inner.Close()
	<-w.done
}

func (w *Watcher) rel(path string) string {
	rel, err := filepath.Rel(w.folder, path)
	if err != nil {
		return path
	}
	return rel
}

func (w *Watcher) addTree(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
			}
			return nil // vanished while walking
		}
		if !d.IsDir() {
			return nil
		}
		if path != w.folder && Ignored(w.rel(path), w.peers) {
			return filepath.SkipDir
		}
		return w.inner.Add(path)
	})
}

func (w *Watcher) run(changed chan<- struct{}) {
	defer close(w.done)
	var timer *time.Timer
	var fire <-chan time.Time
	for {
		select {
		case event, ok := <-w.inner.Events:
			if !ok {
				return
			}
			if Ignored(w.rel(event.Name), w.peers) {
				continue
			}
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					if err := w.addTree(event.Name); err != nil {
						w.healthy.Store(false)
					}
				}
			}
			if timer == nil {
				timer = time.NewTimer(Debounce)
			} else {
				timer.Reset(Debounce)
			}
			fire = timer.C
		case <-fire:
			fire = nil
			select {
			case changed <- struct{}{}:
			default: // a signal is already pending: one round covers both
			}
		case _, ok := <-w.inner.Errors:
			if !ok {
				return
			}
			// an overflow means events were lost: still signal, and say we may have missed some
			w.healthy.Store(false)
			select {
			case changed <- struct{}{}:
			default:
			}
		}
	}
}
