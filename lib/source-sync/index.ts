/**
 * B6-02 — 源稿领先内容安全写入 Blogman public entry (issue #51).
 *
 * Pulls a source-ahead primary source INTO Blogman: normalized title, Markdown
 * body and referenced media, committed through the versioned write kernel
 * (draft → new version; formal article → its unique active revision). The sync
 * baseline only advances when every media item AND the final save succeed
 * (全部成功才推进基线; 任一媒体/保存失败不产生半同步). Media is reused by
 * verifiable content identity, never by filename. Production has no adapters
 * bound (零生产); the provider / media-store interfaces + mocks ship here so
 * the whole failure surface is provable in tests.
 */

export {
  advanceBaseline,
  assetUrlFor,
  baselineFingerprint,
  buildR2Key,
  MediaSyncError,
  normalizeTitle,
  renderMarkdown,
  rewriteMarkdownRefs,
  sha256Hex,
  syncSourceAhead,
} from './kernel'
export { ensureSourceSyncTables, SOURCE_SYNC_DDL_STATEMENTS } from './ddl'
export { MockMediaStore, MockSourceProvider } from './provider'
export type {
  MediaStore,
  MediaSyncFact,
  SourceContent,
  SourceMediaBytes,
  SourceMediaRef,
  SourceProjection,
  SourceProvider,
  SyncSourceInput,
  SyncSourceResult,
} from './types'
