/**
 * B2-04 — editor save coordinator (issue #27).
 *
 * The main editor's versioned autosave / confirm protocol, kept framework-free
 * so it can be unit-tested in node without a browser (shared mocks, no
 * wrangler, no real browser suite).
 *
 * Protocol invariants:
 *
 *   - autosave submits the FULL authoring snapshot + expected version + a
 *     stable operation id through the create/save command transport,
 *   - "saved" is shown ONLY when the current UI still matches the last
 *     server-confirmed snapshot — a stale success can never mark new input
 *     as saved,
 *   - at most ONE local unconfirmed draft per article per device, cleared
 *     only after the server confirms the matching snapshot,
 *   - a conflict pauses autosave and is NEVER auto-merged; the caller offers
 *     the three choices (server version / safe re-submit / save as new draft).
 *
 * Status transitions are NOT part of content autosave: the kernel `save`
 * always carries the article's current status; draft<->published moves go
 * through `publishTemp` (see `saveAndPublish`). Single-page request sequencing
 * and browser caches never become server facts — the operation id / expected
 * version are the only server-side protocols used.
 */

export type EditorSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

/** Authoring fields the editor owns (the content confirmation surface). */
export interface EditorSnapshotContent {
  slug: string
  title: string
  html: string
  content: string
  description: string
  category: string
  tags: string[]
  coverImage: string
}

/** Full snapshot: authoring content + the applied article-state fields. */
export interface EditorSnapshot extends EditorSnapshotContent {
  status: 'draft' | 'published'
  password: string | null
  isHidden: number
  publishedAt: number | null
}

export interface AppliedArticleState {
  status: 'draft' | 'published'
  password: string | null
  isHidden: number
  publishedAt: number | null
}

/** Conflict comparison facts surfaced by the kernel (subset used by the UI). */
export interface ConflictInfo {
  expectedVersion: number
  serverVersion: number
  serverTitle: string | null
  serverUpdatedAt: number | null
}

export interface CoordinatorState {
  status: EditorSaveStatus
  articleId: number | null
  version: number | null
  lastSavedAt: number | null
  errorMessage: string | null
  conflict: ConflictInfo | null
  hasLocalDraft: boolean
  /** Applied article state (what the server last confirmed). */
  applied: AppliedArticleState
}

/** Kernel result union used by the coordinator (transport returns these). */
export type CommandResult =
  | { outcome: 'applied' | 'created' | 'replayed' | 'existing'; articleId: number; postRef: number; version: number; operationId: string; existing: boolean; slug?: string; publishedAt?: number | null; projectionFailures?: string[] }
  | { outcome: 'skipped'; reason: 'blank-session' }
  | { outcome: 'slug-conflict'; slug: string }
  | { outcome: 'conflict'; articleId: number; postRef: number; expectedVersion: number; serverVersion: number; facts: { title?: string | null; updated_at?: number | null } }
  | { outcome: 'status-conflict'; articleId: number; postRef: number; expectedVersion: number; serverVersion: number; currentStatus: string | null }

/** Server version snapshot for the conflict "server version" choice / restore. */
export interface ServerSnapshotResult {
  articleId: number | null
  version: number | null
  snapshot: EditorSnapshot | null
}

export interface CommandTransport {
  create(input: { creationId: string; snapshot: EditorSnapshot }): Promise<CommandResult>
  save(input: {
    articleId: number
    expectedVersion: number
    operationId: string
    snapshot: EditorSnapshot
  }): Promise<CommandResult>
  publishTemp(input: {
    articleId: number
    expectedVersion: number
    currentStatus: string
    operationId: string
    status: 'draft' | 'published'
  }): Promise<CommandResult>
  getServerSnapshot(input: { articleId: number }): Promise<ServerSnapshotResult>
}

export interface LocalDraftRecord {
  articleKey: string
  snapshot: EditorSnapshot
  basedVersion: number | null
  savedAt: number
}

export interface LocalDraftStore {
  load(key: string): LocalDraftRecord | null
  save(key: string, record: LocalDraftRecord): void
  remove(key: string): void
}

export interface SaveCoordinatorOptions {
  /** Server identity at load; null for a brand-new article. */
  articleId: number | null
  /** Latest server version at load; null when the article has no identity yet. */
  version: number | null
  /** Stable new-post key (per device); reused across retries. */
  creationId: string
  /** Current editor authoring fields (content only — state fields are owned here). */
  getContent: () => EditorSnapshotContent
  /** Called when a brand-new create returns a server-assigned slug the editor has not authored. */
  onAppliedSlug?: (slug: string) => void
  transport: CommandTransport
  draftStore: LocalDraftStore
  onStateChange: (state: CoordinatorState) => void
  debounceMs?: number
  maxRetryDelayMs?: number
  now?: () => number
  newOperationId?: () => string
}

export function articleDraftKey(articleId: number): string {
  return `editor-draft:article:${articleId}`
}

export function newDraftKey(creationId: string): string {
  return `editor-draft:new:${creationId}`
}

/** Stable confirmation fingerprint over the authoring content only. */
export function contentKey(content: EditorSnapshotContent): string {
  return JSON.stringify({
    slug: content.slug,
    title: content.title,
    html: content.html,
    content: content.content,
    description: content.description,
    category: content.category,
    tags: content.tags,
    coverImage: content.coverImage,
  })
}

function isBlank(content: EditorSnapshotContent): boolean {
  const hasMedia = /<(img|video|audio|iframe)\b/i.test(content.html)
  return !content.title.trim() && !content.content.trim() && !hasMedia
}

function sameApplied(a: AppliedArticleState, b: AppliedArticleState): boolean {
  return a.status === b.status && a.password === b.password && a.isHidden === b.isHidden && a.publishedAt === b.publishedAt
}

const DEFAULT_DEBOUNCE_MS = 1500
const DEFAULT_MAX_RETRY_DELAY_MS = 10000

export class EditorSaveCoordinator {
  private readonly opts: SaveCoordinatorOptions
  private state: CoordinatorState
  private confirmedContentKey: string | null = null
  private confirmedApplied: AppliedArticleState
  private confirmedVersion: number | null
  private confirmedArticleId: number | null
  private creationId: string
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private inFlight: Promise<boolean> | null = null
  private pending = false
  /** Stable operation for the current unconfirmed snapshot (reused on retry/replay). */
  private currentOperation: { operationId: string; snapshotKey: string } | null = null
  private lastConfirmedSlug: string | null = null

  constructor(opts: SaveCoordinatorOptions) {
    this.opts = opts
    const initialApplied: AppliedArticleState = { status: 'draft', password: null, isHidden: 0, publishedAt: null }
    this.creationId = opts.creationId
    this.confirmedApplied = { ...initialApplied }
    this.confirmedVersion = opts.version
    this.confirmedArticleId = opts.articleId
    this.state = {
      status: 'saved',
      articleId: opts.articleId,
      version: opts.version,
      lastSavedAt: this.now(),
      errorMessage: null,
      conflict: null,
      hasLocalDraft: false,
      applied: { ...initialApplied },
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private newOperationId(): string {
    return this.opts.newOperationId ? this.opts.newOperationId() : crypto.randomUUID()
  }

  private emit(): void {
    this.opts.onStateChange({
      status: this.state.status,
      articleId: this.state.articleId,
      version: this.state.version,
      lastSavedAt: this.state.lastSavedAt,
      errorMessage: this.state.errorMessage,
      conflict: this.state.conflict,
      hasLocalDraft: this.state.hasLocalDraft,
      applied: { ...this.state.applied },
    })
  }

  private setStatus(status: EditorSaveStatus, extra?: Partial<CoordinatorState>): void {
    this.state.status = status
    if (extra) Object.assign(this.state, extra)
    this.emit()
  }

  /** The current draft slot key (article identity when known, else the new-post session). */
  private currentDraftKey(): string {
    return this.state.articleId !== null
      ? articleDraftKey(this.state.articleId)
      : newDraftKey(this.creationId)
  }

  /** Full snapshot for the kernel payload: current content + applied state. */
  private buildSnapshot(): EditorSnapshot {
    return {
      ...this.opts.getContent(),
      status: this.state.applied.status,
      password: this.state.applied.password,
      isHidden: this.state.applied.isHidden,
      publishedAt: this.state.applied.publishedAt,
    }
  }

  /** Whether anything unconfirmed exists (content or applied-state drift). */
  private needsSave(): boolean {
    const current = this.buildSnapshot()
    const contentMatches = this.confirmedContentKey !== null && contentKey(current) === this.confirmedContentKey
    const appliedMatches = this.confirmedArticleId !== null && sameApplied(this.state.applied, this.confirmedApplied)
    return !contentMatches || !appliedMatches
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */

  /** Seed the confirmed baseline after the editor has loaded its content. */
  setInitialConfirmed(): void {
    const snapshot = this.buildSnapshot()
    this.confirmedContentKey = contentKey(snapshot)
    this.confirmedApplied = { ...this.state.applied }
    this.confirmedArticleId = this.state.articleId
    this.setStateSaved()
  }

  /** Seed the applied article-state fields (status / password / isHidden / publishedAt). */
  setAppliedState(partial: Partial<AppliedArticleState>): void {
    this.state.applied = { ...this.state.applied, ...partial }
    this.emit()
  }

  /**
   * Restore the device's unconfirmed draft for this article (refresh recovery).
   * Returns the draft snapshot when it differs from the confirmed baseline
   * (i.e. there is actually something to recover); the caller applies it to
   * the editor and calls `schedule()` to re-submit with its base version.
   */
  restoreLocalDraft(): EditorSnapshot | null {
    const record = this.opts.draftStore.load(this.currentDraftKey())
    if (!record) return null
    // Already confirmed / matches the current baseline — nothing to recover.
    if (this.confirmedContentKey !== null && contentKey(record.snapshot) === this.confirmedContentKey) {
      this.opts.draftStore.remove(this.currentDraftKey())
      this.setStateSaved()
      return null
    }
    this.state.applied = {
      status: record.snapshot.status,
      password: record.snapshot.password,
      isHidden: record.snapshot.isHidden,
      publishedAt: record.snapshot.publishedAt,
    }
    this.state.conflict = null
    if (record.basedVersion !== null) {
      this.state.version = record.basedVersion
      this.confirmedVersion = record.basedVersion
    }
    this.state.hasLocalDraft = true
    this.setStateDirty()
    return record.snapshot
  }

  /** Debounced autosave. Paused while a conflict is open; never auto-merges. */
  schedule(): void {
    if (this.state.status === 'conflict') return
    if (this.state.status !== 'saving') this.setStatus('dirty')
    this.clearDebounce()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.run()
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  /** Immediate content save (manual save / before unload). Resolves once fully drained. */
  flush(): Promise<boolean> {
    this.clearDebounce()
    return this.run()
  }

  /**
   * Explicit save + optional status transition (the "保存草稿/发布/更新" action).
   * Content/fields are saved first (password / isHidden overrides are applied),
   * then `publishTemp` moves draft<->published when the target differs from the
   * article's current status. A conflict pauses and is never merged.
   */
  async saveAndPublish(target: {
    status: 'draft' | 'published'
    password?: string | null
    isHidden?: number
  }): Promise<{ ok: boolean; error?: 'conflict' | 'status-conflict' | 'network' }> {
    if (this.state.status === 'conflict') return { ok: false, error: 'conflict' }

    // Apply the field intent (password / isHidden are content-level facts).
    if (target.password !== undefined) this.state.applied.password = target.password
    if (target.isHidden !== undefined) this.state.applied.isHidden = target.isHidden

    const contentSaved = await this.flush()
    if (!contentSaved) {
      return { ok: false, error: this.state.conflict !== null ? 'conflict' : 'network' }
    }

    if (this.state.applied.status === target.status) return { ok: true }

    const res = await this.opts.transport.publishTemp({
      articleId: this.state.articleId as number,
      expectedVersion: this.state.version as number,
      currentStatus: this.state.applied.status,
      operationId: this.newOperationId(),
      status: target.status,
    })
    if (res.outcome === 'applied' || res.outcome === 'replayed') {
      this.state.applied.status = target.status
      if (res.publishedAt !== undefined) this.state.applied.publishedAt = res.publishedAt
      this.state.version = res.version
      this.confirmedApplied = { ...this.state.applied }
      this.confirmedVersion = res.version
      this.setStateSaved()
      return { ok: true }
    }
    if (res.outcome === 'conflict') {
      this.enterConflict(res)
      return { ok: false, error: 'conflict' }
    }
    // status-conflict — never auto-resolve.
    this.enterError('文章状态已被其他设备修改，请刷新后重试', this.buildSnapshot(), { retry: false })
    return { ok: false, error: 'status-conflict' }
  }

  /** Conflict choice 1 — adopt the server version (discards the local draft). */
  async adoptServerVersion(): Promise<EditorSnapshot | null> {
    const articleId = this.state.articleId
    if (articleId === null) return null
    const info = await this.opts.transport.getServerSnapshot({ articleId })
    if (!info.snapshot || info.version === null) return null

    this.state.applied = {
      status: info.snapshot.status,
      password: info.snapshot.password,
      isHidden: info.snapshot.isHidden,
      publishedAt: info.snapshot.publishedAt,
    }
    this.confirmedApplied = { ...this.state.applied }
    this.confirmedContentKey = contentKey(info.snapshot)
    this.confirmedVersion = info.version
    this.confirmedArticleId = info.articleId
    this.state.version = info.version
    this.state.articleId = info.articleId
    this.currentOperation = null
    this.lastConfirmedSlug = info.snapshot.slug
    this.retryAttempt = 0
    this.clearRetry()
    this.opts.draftStore.remove(this.currentDraftKey())
    this.setStateSaved()
    return info.snapshot
  }

  /** Conflict choice 2 — safe re-submit of the local version with the current expected version. */
  async resubmitLocal(): Promise<boolean> {
    if (this.state.status !== 'conflict' || this.state.conflict === null) return false
    this.state.version = this.state.conflict.serverVersion
    this.confirmedVersion = this.state.conflict.serverVersion
    this.clearRetry()
    this.setStateDirty()
    return this.run()
  }

  /** Conflict choice 3 — preserve local content as a brand-new draft article. */
  async saveAsNewDraft(): Promise<{ ok: boolean; slug?: string; error?: string }> {
    const snapshot = this.buildSnapshot()
    const creationId = this.newOperationId()
    const res = await this.opts.transport.create({
      creationId,
      // A fresh article must not reuse the conflicted slug — the route assigns an auto slug.
      snapshot: { ...snapshot, slug: '' },
    })
    if (res.outcome === 'created' || res.outcome === 'existing') {
      this.creationId = creationId
      this.state.articleId = res.articleId
      this.state.version = res.version
      this.confirmedArticleId = res.articleId
      this.confirmedVersion = res.version
      this.confirmedApplied = { ...this.state.applied }
      this.currentOperation = null
      this.retryAttempt = 0
      this.clearRetry()
      this.opts.draftStore.remove(this.currentDraftKey())
      const appliedSlug = res.slug && res.slug !== snapshot.slug ? res.slug : snapshot.slug
      if (appliedSlug) {
        this.confirmedContentKey = contentKey({ ...snapshot, slug: appliedSlug })
        this.lastConfirmedSlug = appliedSlug
      }
      this.setStateSaved()
      return { ok: true, slug: appliedSlug }
    }
    if (res.outcome === 'slug-conflict') {
      this.enterError('slug 已存在，请换一个', snapshot)
      return { ok: false, error: res.slug }
    }
    return { ok: false, error: '保存失败，请重试' }
  }

  /**
   * Explicit create for a brand-new post with the selected status (建稿 + 发布).
   * A new article has no identity yet, so the status is carried by `create`
   * itself (no publishTemp — publishTemp needs an existing article).
   */
  async createNew(target: {
    status: 'draft' | 'published'
    password?: string | null
    isHidden?: number
  }): Promise<{ ok: boolean; slug?: string; error?: string }> {
    if (this.state.status === 'conflict') return { ok: false, error: '请先处理冲突' }
    if (target.password !== undefined) this.state.applied.password = target.password
    if (target.isHidden !== undefined) this.state.applied.isHidden = target.isHidden
    this.state.applied.status = target.status
    this.state.applied.publishedAt = null // first-publish handled by the create kernel
    const saved = await this.flush()
    if (!saved) {
      return { ok: false, error: this.state.conflict !== null ? '请先处理冲突' : '保存失败，请重试' }
    }
    return { ok: true, slug: this.lastConfirmedSlug ?? undefined }
  }

  /** Reset to a brand-new blank post (after finishing / clearing the editor). */
  resetForNewPost(newCreationId: string): void {
    this.creationId = newCreationId
    this.currentOperation = null
    this.confirmedContentKey = null
    this.confirmedArticleId = null
    this.confirmedVersion = null
    this.lastConfirmedSlug = null
    this.state.conflict = null
    this.state.errorMessage = null
    this.state.applied = { status: 'draft', password: null, isHidden: 0, publishedAt: null }
    this.confirmedApplied = { ...this.state.applied }
    this.state.articleId = null
    this.state.version = null
    this.state.hasLocalDraft = false
    this.clearRetry()
    this.setStateSaved()
  }

  /** Persist the current UI as the device's unconfirmed draft (beforeunload / offline). */
  persistLocalDraft(): void {
    if (!this.needsSave()) return
    const snapshot = this.buildSnapshot()
    const key = this.currentDraftKey()
    this.opts.draftStore.save(key, {
      articleKey: key,
      snapshot,
      basedVersion: this.state.version,
      savedAt: this.now(),
    })
    this.state.hasLocalDraft = true
    this.emit()
  }

  dispose(): void {
    this.clearDebounce()
    this.clearRetry()
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                         */
  /* ---------------------------------------------------------------- */

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private setStateSaved(): void {
    this.retryAttempt = 0
    this.setStatus('saved', { lastSavedAt: this.now(), errorMessage: null })
  }

  private setStateDirty(): void {
    this.setStatus('dirty', { errorMessage: null })
  }

  private setStateSaving(): void {
    this.setStatus('saving', { errorMessage: null })
  }

  private enterError(message: string, snapshot: EditorSnapshot, opts: { retry?: boolean } = {}): void {
    this.persistLocalDraftAt(snapshot)
    this.clearRetry()
    this.setStatus('error', { errorMessage: message })
    // Hard, persistent errors (slug-conflict and friends) never auto-retry —
    // only transient network failures schedule a bounded backoff retry.
    if (opts.retry === false) return
    const attempt = this.retryAttempt
    this.retryAttempt = attempt + 1
    const delay = Math.min(
      this.opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      2000 * (2 ** attempt),
    )
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.run()
    }, delay)
  }

  private persistLocalDraftAt(snapshot: EditorSnapshot): void {
    const key = this.currentDraftKey()
    this.opts.draftStore.save(key, {
      articleKey: key,
      snapshot,
      basedVersion: this.state.version,
      savedAt: this.now(),
    })
    this.state.hasLocalDraft = true
  }

  private enterConflict(result: Extract<CommandResult, { outcome: 'conflict' }>): void {
    this.persistLocalDraftAt(this.buildSnapshot())
    this.clearRetry()
    this.setStatus('conflict', {
      conflict: {
        expectedVersion: result.expectedVersion,
        serverVersion: result.serverVersion,
        serverTitle: result.facts.title ?? null,
        serverUpdatedAt: result.facts.updated_at ?? null,
      },
    })
  }

  /** Clear the local draft only when the confirmed snapshot matches it. */
  private clearDraftIfMatches(sent: EditorSnapshot): void {
    const key = this.currentDraftKey()
    const record = this.opts.draftStore.load(key)
    if (record && contentKey(record.snapshot) === contentKey(sent)) {
      this.opts.draftStore.remove(key)
      this.state.hasLocalDraft = this.opts.draftStore.load(key) !== null
    }
  }

  /**
   * Serialized save pipeline: at most one request in flight; any input made
   * meanwhile sets `pending` and is processed by the loop afterwards. This is
   * what makes a stale success unable to mark new input as saved.
   */
  private async run(): Promise<boolean> {
    if (this.state.status === 'conflict') return false
    if (this.inFlight !== null) {
      this.pending = true
      return this.inFlight
    }
    this.inFlight = this.perform()
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async perform(): Promise<boolean> {
    for (;;) {
      if (this.state.status === 'conflict') return false
      const snapshot = this.buildSnapshot()

      // Blank session — the kernel would skip it; nothing to confirm.
      if (isBlank(snapshot)) {
        this.setStateSaved()
        return true
      }
      if (!this.needsSave()) {
        this.setStateSaved()
        return true
      }

      // Stable operation id: reuse while the unconfirmed snapshot is unchanged
      // (response-lost retries replay server-side; never duplicates versions).
      const snapshotKey = contentKey(snapshot)
      let operationId: string
      if (this.currentOperation && this.currentOperation.snapshotKey === snapshotKey) {
        operationId = this.currentOperation.operationId
      } else {
        operationId = this.newOperationId()
        this.currentOperation = { operationId, snapshotKey }
      }

      this.setStateSaving()
      this.persistLocalDraftAt(snapshot)

      const ok = await this.execute(snapshot, operationId)
      if (this.pending) {
        this.pending = false
        continue
      }
      return ok
    }
  }

  private async execute(snapshot: EditorSnapshot, operationId: string): Promise<boolean> {
    let result: CommandResult
    try {
      if (this.state.articleId === null) {
        result = await this.opts.transport.create({ creationId: this.creationId, snapshot })
      } else {
        result = await this.opts.transport.save({
          articleId: this.state.articleId,
          expectedVersion: this.state.version as number,
          operationId,
          snapshot,
        })
      }
    } catch (error) {
      this.enterError(error instanceof Error ? error.message : '保存失败', snapshot)
      return false
    }

    if (result.outcome === 'created' || result.outcome === 'existing' || result.outcome === 'applied' || result.outcome === 'replayed') {
      this.handleConfirmed(snapshot, operationId, result)
      return true
    }
    if (result.outcome === 'skipped') {
      this.setStateSaved()
      return true
    }
    if (result.outcome === 'slug-conflict') {
      this.enterError('slug 已存在，请换一个', snapshot, { retry: false })
      return false
    }
    if (result.outcome === 'conflict') {
      this.enterConflict(result)
      return false
    }
    // status-conflict cannot arrive from create/save — defensive.
    this.enterError('保存失败，请刷新后重试', snapshot)
    return false
  }

  private handleConfirmed(
    sent: EditorSnapshot,
    operationId: string,
    result: Extract<CommandResult, { outcome: 'applied' | 'created' | 'replayed' | 'existing' }>,
  ): void {
    const createdIdentity = this.state.articleId === null

    // Server facts are now confirmed even if the UI moved on meanwhile.
    if (result.articleId !== undefined) this.state.articleId = result.articleId
    this.state.version = result.version
    this.confirmedVersion = result.version
    this.confirmedArticleId = this.state.articleId

    const appliedSlug = result.slug && result.slug !== sent.slug ? result.slug : sent.slug
    this.lastConfirmedSlug = appliedSlug
    // A brand-new create may have the server auto-assign a slug (blank-session
    // auto-slug / conflict-avoidance). That slug is a server fact the editor has
    // not adopted yet — baking it into the confirmation key would make the
    // just-confirmed content look perpetually dirty. Notify so the editor adopts
    // it, and keep the baseline at the snapshot the editor actually sent.
    const serverAssignedSlug = createdIdentity && appliedSlug !== sent.slug
    let appliedSnapshot: EditorSnapshot
    if (serverAssignedSlug) {
      appliedSnapshot = sent
      this.confirmedContentKey = contentKey(sent)
      this.opts.onAppliedSlug?.(appliedSlug)
    } else {
      appliedSnapshot = appliedSlug !== sent.slug ? { ...sent, slug: appliedSlug } : sent
      this.confirmedContentKey = contentKey(appliedSnapshot)
    }
    if (result.publishedAt !== undefined) this.state.applied.publishedAt = result.publishedAt
    this.confirmedApplied = { ...this.state.applied }

    // Migrate the draft slot when a new-post session gains its server identity.
    if (createdIdentity) this.opts.draftStore.remove(newDraftKey(this.creationId))
    this.clearDraftIfMatches(appliedSnapshot)

    if (this.currentOperation && this.currentOperation.operationId === operationId) {
      this.currentOperation = null
    }

    const current = this.buildSnapshot()
    if (this.confirmedContentKey !== null && contentKey(current) === this.confirmedContentKey) {
      this.setStateSaved()
    } else {
      // The UI changed while the request was in flight: the old success must
      // NOT mark the new input as saved; the loop picks up the newer snapshot.
      this.setStateDirty()
    }
  }
}
