package layout

import "testing"

func TestAccountFileLivesUnderFolderSync(t *testing.T) {
	for goos, want := range map[string]string{
		"linux":   "/home/bam/.folder-sync/account.json",
		"darwin":  "/home/bam/.folder-sync/account.json",
		"windows": `C:\Users\BAM\.folder-sync\account.json`,
	} {
		home := map[string]string{"HOME": "/home/bam", "USERPROFILE": `C:\Users\BAM`}
		l, err := For(goos, env(home))
		if err != nil {
			t.Fatal(err)
		}
		if l.Account != want {
			t.Errorf("%s: Account = %q, want %q", goos, l.Account, want)
		}
		found := false
		for _, path := range l.All() {
			found = found || path == l.Account
		}
		if !found {
			t.Errorf("%s: Account is missing from All(), so the escape check would not cover it", goos)
		}
	}
}
