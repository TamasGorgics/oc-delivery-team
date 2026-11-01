from slug import slugify_title


def test_slugify_title():
    assert slugify_title("  Add Search & Filtering! ") == "add-search-filtering"
