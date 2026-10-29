package syncer

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
