package build

import (
	"strings"
	"testing"
)

func TestRoutePathsStayInsideTheSite(t *testing.T) {
	routes := map[string]string{"blog": "/blog/:fields(title)"}
	for _, title := range []string{"../../escaped", "..", "a/../../b"} {
		_, err := buildContent(t, map[string]string{
			"blog/post.json": `{"title": "` + title + `"}`,
		}, routes)
		if err == nil || !strings.Contains(err.Error(), "leads outside the site") {
			t.Errorf("title %q: want an error, got %v", title, err)
		}
	}
	// Dots inside a name are fine, and slugify already turns "\\" into "-".
	paths, err := buildContent(t, map[string]string{
		"blog/post.json": `{"title": "v1..2 notes"}`,
	}, routes)
	if err != nil || paths["blog/post.json"] != "/blog/v1..2-notes" {
		t.Errorf("want /blog/v1..2-notes, got %q (%v)", paths["blog/post.json"], err)
	}
}
