package slug

import "testing"

func TestSlugifyTitle(t *testing.T) {
	if got := slugifyTitle("  Add Search & Filtering! "); got != "add-search-filtering" {
		t.Fatalf("slugifyTitle() = %q, want %q", got, "add-search-filtering")
	}
}
