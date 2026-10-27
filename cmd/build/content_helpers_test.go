package build

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/plentico/plenti/readers"
)

// buildContent writes content files into a temporary site, runs DataSource
// there with the given routes and returns each node's path by file.
func buildContent(t *testing.T, files map[string]string, routes map[string]string) (map[string]string, error) {
	t.Helper()
	dir := t.TempDir()
	for name, src := range files {
		path := filepath.Join(dir, "content", name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(src), 0644); err != nil {
			t.Fatal(err)
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	nodes, err := DataSource(readers.SiteConfig{Routes: routes})
	paths := map[string]string{}
	for _, n := range nodes {
		paths[n.FilePath] = n.Path
	}
	return paths, err
}
