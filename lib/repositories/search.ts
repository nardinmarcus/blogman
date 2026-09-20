import type { Database } from '@/lib/repositories/schema'
import type { PostWithTags } from '@/lib/repositories/types'
import { searchAdminPosts, searchPublicPosts } from '@/lib/public-read/search'

/** Compatibility adapter for existing admin callers and public search. */
export function searchPosts(
  db: Database,
  query: string,
  limit = 20,
  includeDrafts = false,
  includeEncrypted = false,
  includeHidden = false,
  includeDeleted = false,
): Promise<PostWithTags[]> {
  return includeDrafts || includeEncrypted || includeHidden || includeDeleted
    ? searchAdminPosts(db, query, limit, includeDrafts, includeEncrypted, includeHidden, includeDeleted)
    : searchPublicPosts(db, query, limit)
}
