package rclone

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"folder-sync/internal/creds"
	"folder-sync/internal/layout"
)

func TestEveryCallPinsItsDirsUnderFolderSync(t *testing.T) {
	l, err := layout.For("windows", func(key string) string {
		return map[string]string{"USERPROFILE": `C:\Users\BAM`, "APPDATA": `C:\Users\BAM\AppData\Roaming`}[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Layout: l}
	flags := r.GlobalFlags()
	want := map[string]string{
		"--config":    `C:\Users\BAM\.folder-sync\rclone.conf`,
		"--cache-dir": `C:\Users\BAM\.folder-sync\cache`,
		"--temp-dir":  `C:\Users\BAM\.folder-sync\tmp`,
	}
	for i := 0; i < len(flags)-1; i++ {
		if path, ok := want[flags[i]]; ok {
			if flags[i+1] != path {
				t.Errorf("%s = %s, want %s", flags[i], flags[i+1], path)
			}
			delete(want, flags[i])
		}
	}
	if len(want) > 0 {
		t.Fatalf("missing flags %v in %q", want, flags)
	}
}

func TestEnvCarriesTheRemoteAndDropsTheUsersRcloneSettings(t *testing.T) {
	r := Runner{Creds: creds.Creds{AccessKeyID: "id", SecretAccessKey: "secret", Endpoint: "https://a.r2.cloudflarestorage.com", Provider: "Cloudflare", Region: "auto"}}
	env := r.Env([]string{"PATH=/bin", "RCLONE_CONFIG=/home/x/.config/rclone/rclone.conf", "rclone_config_other_type=s3", "HOME=/h"})
	joined := strings.Join(env, "\n")
	for _, gone := range []string{"RCLONE_CONFIG=/home/x", "rclone_config_other"} {
		if strings.Contains(joined, gone) {
			t.Errorf("%s leaked into rclone's environment", gone)
		}
	}
	for _, kept := range []string{"PATH=/bin", "HOME=/h", "RCLONE_CONFIG_FSREMOTE_TYPE=s3", "RCLONE_CONFIG_FSREMOTE_SECRET_ACCESS_KEY=secret",
		"RCLONE_CONFIG_FSREMOTE_NO_CHECK_BUCKET=true", "RCLONE_CONFIG_FSREMOTE_PROVIDER=Cloudflare"} {
		if !strings.Contains(joined, kept) {
			t.Errorf("missing %s", kept)
		}
	}
}

func TestPath(t *testing.T) {
	if got := Path("bkt", "/demo/hosts/x"); got != "fsremote:bkt/demo/hosts/x" {
		t.Fatal(got)
	}
}

// WHY: `rclone version` alone creates ~/.config/rclone, which the README promises never
// happens (everything lives in ~/.folder-sync/). Version must say where the config is.
func TestVersionPassesTheConfigUnderFolderSync(t *testing.T) {
	home := t.TempDir()
	l, err := layout.For("darwin", func(key string) string { return map[string]string{"HOME": home}[key] })
	if err != nil {
		t.Fatal(err)
	}
	argvFile := filepath.Join(home, "argv")
	fake := filepath.Join(home, "rclone")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argvFile + "\necho 'rclone v1.75.2'\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Skip("cannot write a fake rclone here:", err)
	}
	line, err := Version(fake, l)
	if err != nil || line != "rclone v1.75.2" {
		t.Fatalf("%q %v", line, err)
	}
	data, _ := os.ReadFile(argvFile)
	argv := strings.Split(strings.TrimSpace(string(data)), "\n")
	if argv[0] != "version" {
		t.Errorf("argv = %q", argv)
	}
	conf := ""
	for i := 0; i < len(argv)-1; i++ {
		if argv[i] == "--config" {
			conf = argv[i+1]
		}
	}
	if conf != filepath.Join(home, ".folder-sync", "rclone.conf") {
		t.Errorf("--config = %q in %q", conf, argv)
	}
}

func TestFailFastTrimsRetriesOnlyWhenAsked(t *testing.T) {
	r := Runner{}
	if strings.Contains(strings.Join(r.GlobalFlags(), " "), "--retries") {
		t.Fatalf("default flags trim retries: %q", r.GlobalFlags())
	}
	r.FailFast = true
	joined := strings.Join(r.GlobalFlags(), " ")
	for _, want := range []string{"--retries 1", "--low-level-retries 2", "--contimeout 5s"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("FailFast flags %q lack %q", joined, want)
		}
	}
}
