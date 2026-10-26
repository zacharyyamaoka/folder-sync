package layout

import "testing"

func TestSessionCacheLivesUnderFolderSync(t *testing.T) {
	for goos, want := range map[string]string{
		"linux":   "/home/bam/.folder-sync/session.json",
		"darwin":  "/home/bam/.folder-sync/session.json",
		"windows": `C:\Users\BAM\.folder-sync\session.json`,
	} {
		home := map[string]string{"HOME": "/home/bam", "USERPROFILE": `C:\Users\BAM`}
		l, err := For(goos, env(home))
		if err != nil {
			t.Fatal(err)
		}
		if l.Session != want {
			t.Errorf("%s: Session = %q, want %q", goos, l.Session, want)
		}
		found := false
		for _, path := range l.All() {
			found = found || path == l.Session
		}
		if !found {
			t.Errorf("%s: Session is missing from All(), so the escape check would not cover it", goos)
		}
	}
}
