package e2e

import "syscall"

// holdExclusive opens path with no sharing, the way Word or an antivirus scan holds a file: nobody else can read, write
// or delete it until release is called.
func holdExclusive(path string) (release func(), err error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, 0 /* share mode: none */, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return func() { syscall.CloseHandle(handle) }, nil
}
