//go:build !windows

package e2e

import "errors"

// holdExclusive has no meaning off Windows: Unix lets every reader in. TestWindowsFileHeldOpenDuringSync skips there.
func holdExclusive(path string) (release func(), err error) {
	return nil, errors.New("exclusive file locks are a Windows thing")
}
