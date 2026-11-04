package syncer

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// deadPID is the pid of a process that has just exited.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

// A hard-killed engine cannot release its lock, and on Windows every stop is a hard kill (no SIGTERM): the Windows CI run
// (2026-10-29) left `lock` behind and the next `sync --once` exited 75, "another round is running", for 30 minutes. The lock
// names its holder's pid, so a holder that is gone is not holding it.
func TestALockLeftByAProcessThatIsGoneIsTaken(t *testing.T) {
	p := &Project{StateDir: t.TempDir()}
	lock := filepath.Join(p.StateDir, "lock")
	os.WriteFile(lock, []byte(fmt.Sprintf("pid %d at %s\n", deadPID(t), time.Now().UTC().Format(time.RFC3339))), 0o600)
	l, err := p.AcquireLock()
	if err != nil {
		t.Fatalf("a lock whose holder exited must be taken: %v", err)
	}
	l.Release()
}

func TestALockHeldByALiveProcessIsRespected(t *testing.T) {
	p := &Project{StateDir: t.TempDir()}
	first, err := p.AcquireLock() // this process's own pid, alive
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	if _, err := p.AcquireLock(); !errors.Is(err, ErrBusy) {
		t.Fatalf("a second round while the first runs must be busy: %v", err)
	}
}

// The lock must never be seen without its holder. WHY (gate G1, the soak at seed 81 under load: `sync --once` killed 93 ms in,
// then the next round on that machine exited 75, "another folder-sync round is running for this folder (…/lock: )"): the lock
// was created first and its pid written after, so a kill between the two left an empty lock, whose holder nobody could check,
// and every round after it was refused for staleLock (30 minutes). A reader that can see the lock empty is a kill that can
// leave it so.
func TestTheLockIsNeverSeenWithoutItsHolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		// WHY: a reader holding the lock open makes Windows refuse its delete, and the next take of a name pending delete; that
		// is the reader, not the lock. The take itself is the same code on every OS, and the tests below run there.
		t.Skip("Windows refuses to delete a file another handle has open")
	}
	p := &Project{StateDir: t.TempDir()}
	path := filepath.Join(p.StateDir, "lock")
	var empty, seen atomic.Int64
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if data, err := os.ReadFile(path); err == nil {
				seen.Add(1)
				if len(data) == 0 {
					empty.Add(1)
				}
			}
		}
	}()
	for i := 0; i < 20000; i++ {
		l, err := p.AcquireLock()
		if err != nil {
			t.Fatal(err)
		}
		l.Release()
	}
	close(stop)
	<-done
	if n := empty.Load(); n > 0 {
		t.Fatalf("a reader saw the lock with no holder in it %d times (of %d reads that found it): a kill at that moment leaves a lock nobody can check", n, seen.Load())
	}
	if seen.Load() == 0 {
		t.Fatal("the reader never found the lock: the test proved nothing")
	}
}

// An empty lock was left by a holder killed between creating it and writing its pid (an engine before the one above, or a disk
// with no hard links, where the lock is still created and then written). A live holder writes its pid at once, so a fresh empty
// lock is respected and one that has stayed empty for emptyLockGrace is taken, not waited on for 30 minutes.
func TestAnEmptyLockIsTakenOnceItsHolderCannotStillBeWritingIt(t *testing.T) {
	p := &Project{StateDir: t.TempDir()}
	lock := filepath.Join(p.StateDir, "lock")
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireLock(); !errors.Is(err, ErrBusy) {
		t.Fatalf("an empty lock made a moment ago may be a holder about to write its pid: %v", err)
	}
	old := time.Now().Add(-time.Minute)
	os.Chtimes(lock, old, old)
	l, err := p.AcquireLock()
	if err != nil {
		t.Fatalf("an empty lock a minute old was left by a holder that died before writing its pid: %v", err)
	}
	if data, _ := os.ReadFile(lock); !strings.HasPrefix(string(data), fmt.Sprintf("pid %d ", os.Getpid())) {
		t.Fatalf("the lock taken names this process: %q", data)
	}
	l.Release()
}

// A taker killed between writing its holder and linking it leaves that file behind; the next taker removes it once no live
// taker can still be using it, and touches nothing else in the state folder.
func TestALockTempLeftByAKilledTakerIsSwept(t *testing.T) {
	p := &Project{StateDir: t.TempDir()}
	old := time.Now().Add(-time.Minute)
	for _, name := range []string{"lock.0badf00d.tmp", "lock.c0ffee00.tmp", "last-sync.json.tmp"} {
		os.WriteFile(filepath.Join(p.StateDir, name), []byte("pid 1 at 2026-11-04T10:00:00Z\n"), 0o600)
		os.Chtimes(filepath.Join(p.StateDir, name), old, old)
	}
	os.WriteFile(filepath.Join(p.StateDir, "lock.c0ffee00.tmp"), []byte("pid 2 at now\n"), 0o600) // fresh: a live taker's
	l, err := p.AcquireLock()
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
	entries, _ := os.ReadDir(p.StateDir)
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if got := strings.Join(names, " "); got != "last-sync.json.tmp lock lock.c0ffee00.tmp" {
		t.Fatalf("the state folder holds %s", got)
	}
}
