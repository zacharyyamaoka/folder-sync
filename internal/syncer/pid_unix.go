//go:build !windows

package syncer

import (
	"errors"
	"syscall"
)

// pidRunning reports whether a process with this pid exists. EPERM means it does, under another user.
func pidRunning(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
