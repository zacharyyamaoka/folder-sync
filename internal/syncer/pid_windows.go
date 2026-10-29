package syncer

import "syscall"

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// pidRunning reports whether a process with this pid exists and has not exited. A handle can outlive its process, so
// OpenProcess succeeding is not enough: the exit code says whether it is still running.
func pidRunning(pid int) bool {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return err == syscall.ERROR_ACCESS_DENIED // there, but not ours to inspect
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return true
	}
	return code == stillActive
}
