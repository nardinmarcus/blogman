const unrepresentedPostsSql =
  'SELECT COUNT(*) AS count FROM posts WHERE id NOT IN (SELECT post_ref FROM articles)'

export async function prepare({ query }) {
  const [table] = query("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'posts'")
  if (Number(table?.count) === 0) return ''

  const [unrepresented] = query(unrepresentedPostsSql)
  const count = Number(unrepresented?.count)
  if (count > 0) {
    throw new Error(
      `posts still holds ${count} row(s) without a canonical article identity; migrate them before retiring the projection`,
    )
  }

  return `
CREATE TABLE __blogman_migration_009_posts_guard (
  verified INTEGER NOT NULL,
  CONSTRAINT "posts gained rows without a canonical article identity after migration preparation"
    CHECK(verified = 1)
);
INSERT INTO __blogman_migration_009_posts_guard (verified)
SELECT CASE WHEN (${unrepresentedPostsSql}) = 0 THEN 1 ELSE 0 END;
DROP TABLE __blogman_migration_009_posts_guard;
`.trim()
}
