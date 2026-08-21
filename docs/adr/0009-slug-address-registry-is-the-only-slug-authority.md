# The slug address registry is the only slug authority

Slug exclusivity was checked in three places: the legacy global `posts.slug`, `formal_publications.slug` (formal rows only), and `article_slug_addresses` (current/candidate/historical, fed only by the publish-revision flow). We decided the slug address registry becomes the single authority for slug exclusivity and resolution: first-publish registers the formal slug as `current` in the same transaction, and create/save reserve draft slugs through the registry, instead of patching together checks against the other two sources.
