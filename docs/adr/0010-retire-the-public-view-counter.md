# Retire the public view counter

Public reads have been canonical-only since PR #232/#233 and canonical facts carry no view counter, so the displayed count was already dead (0 or stale) while the detail page still wrote `posts.view_count` on every visit — the last public-path write against the retiring projection. We decided to remove the increment call and the read-count display entirely rather than rebuild an approximate counter on KV; view counts can return later as a properly canonical feature if wanted.
