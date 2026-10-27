package build

import (
	"sort"
	"testing"
)

func TestRoutesWithFilename(t *testing.T) {
	paths, err := buildContent(t, map[string]string{
		"blog/welcome-to-our-site.json": `{"title": "5 things to know"}`,
		"blog/Second_Post.json":         `{"title": "Another"}`,
		"news/first.json":               `{"title": "Hello World"}`,
	}, map[string]string{
		"blog": "/blog/post/:filename",
		"news": "/news/:fields(title)-:filename",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"blog/welcome-to-our-site.json": "/blog/post/welcome-to-our-site",
		"blog/Second_Post.json":         "/blog/post/second-post",
		"news/first.json":               "/news/hello-world-first",
	}
	for file, path := range want {
		if paths[file] != path {
			t.Errorf("%s: want %q, got %q", file, path, paths[file])
		}
	}
	keys := []string{}
	for k := range paths {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(paths) != len(want) {
		t.Errorf("want %d nodes, got %v", len(want), keys)
	}
}
