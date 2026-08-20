/**
 * B6-04 — 明确选边: unified writable-source mock (issue #53).
 *
 * The conflict kernel depends on the SAME boundaries as B6-02/B6-03: a
 * `SourceProvider` (read title/markdown/media) and a `SourceWriteProvider`
 * (read the source's content hash + push write-back content). Zero production —
 * this BATCH ships the mock only. `MockWritableSource` is ONE in-memory source
 * standing behind BOTH faces: reading returns the current content, pushing
 * write-back content REPLACES it, and the hash convention is the conflict
 * kernel's own content fingerprint (source-only — title + rewritten markdown +
 * referenced-media content hashes), so a poll/probe and a push/confirm agree
 * on what "the source holds" deterministically.
 */

import {
  assetUrlFor,
  baselineFingerprint,
  buildR2Key,
  normalizeTitle,
  rewriteMarkdownRefs,
  sha256Hex,
  type MediaSyncFact,
  type SourceContent,
  type SourceMediaBytes,
  type SourceProvider,
} from '@/lib/source-sync'
import type { SourceWriteProvider } from '@/lib/source-writeback'

export type { SourceProvider } from '@/lib/source-sync'
export type { SourceWriteProvider } from '@/lib/source-writeback'

/** One in-memory writable primary source behind BOTH provider faces. */
export class MockWritableSource implements SourceProvider, SourceWriteProvider {
  readonly kind = 'mock-writable-source'

  private content: SourceContent
  private bytes: Record<string, Buffer> = {}
  private pushed: Array<{ sourceUrl: string; title: string; body: string }> = []
  private _failNextRead = false
  private _failNextPush = false
  private _failNextMediaRead: string[] = []
  totalReads = 0

  constructor(content: SourceContent) {
    this.content = content
  }

  /** The current source snapshot (test inspection / seeding helpers). */
  get current(): SourceContent {
    return this.content
  }

  /** The content fingerprint of the CURRENT state — the shared hash. */
  currentFingerprint(): string {
    return this.fingerprintOf(this.content)
  }

  /** Rewritten markdown (refs → asset URLs) for the CURRENT state. */
  currentRewrittenMarkdown(): string {
    return this.rewriteMarkdownOf(this.content)
  }

  /** Add or override the raw bytes for one media ref (content identity derived from these). */
  setMediaBytes(ref: string, bytes: Buffer | Uint8Array): this {
    this.bytes[ref] = Buffer.from(bytes)
    return this
  }

  /** Replace the whole source snapshot (simulates an external source edit). */
  setContent(content: SourceContent): this {
    this.content = content
    return this
  }

  /** Simulate the source/device being unavailable on the NEXT readSource() call. */
  failNextRead(): this {
    this._failNextRead = true
    return this
  }

  /** Simulate the source/device being unavailable on the NEXT pushWriteBack() call. */
  failNextPush(): this {
    this._failNextPush = true
    return this
  }

  /** Make readMediaBytes(ref) throw for the given ref (media-only outage). */
  failMediaRead(ref: string): this {
    this._failNextMediaRead.push(ref)
    return this
  }

  /** The source-content fingerprint of the CURRENT state — the shared hash. */
  private fingerprintOf(c: SourceContent): string {
    return baselineFingerprint(normalizeTitle(c.title), this.rewriteMarkdownOf(c), this.mediaFactsOf(c))
  }

  /** Rewrite the source's markdown refs to content-addressed asset URLs. */
  private rewriteMarkdownOf(c: SourceContent): string {
    const refToUrl: Record<string, string> = {}
    for (const ref of c.media) {
      const raw = this.bytes[ref.ref]
      const sha = raw ? sha256Hex(raw) : ''
      refToUrl[ref.ref] = assetUrlFor(buildR2Key(sha))
    }
    return rewriteMarkdownRefs(c.markdown, refToUrl)
  }

  /** The media facts (ref + content hash + asset url) of the given content. */
  private mediaFactsOf(c: SourceContent): MediaSyncFact[] {
    const facts: MediaSyncFact[] = []
    for (const ref of c.media) {
      const raw = this.bytes[ref.ref]
      const sha = raw ? sha256Hex(raw) : ''
      facts.push({
        ref: ref.ref,
        contentSha256: sha,
        r2Key: buildR2Key(sha),
        assetUrl: assetUrlFor(buildR2Key(sha)),
        reused: false,
      })
    }
    return facts
  }

  /* SourceProvider face */
  async readSource(): Promise<SourceContent> {
    this.totalReads += 1
    if (this._failNextRead) {
      this._failNextRead = false
      throw new Error('mock-source-unavailable')
    }
    return this.content
  }

  async readMediaBytes(ref: string): Promise<SourceMediaBytes> {
    if (this._failNextMediaRead.includes(ref)) {
      this._failNextMediaRead = this._failNextMediaRead.filter((r) => r !== ref)
      throw new Error(`mock-media-unavailable:${ref}`)
    }
    const raw = this.bytes[ref]
    if (!raw) throw new Error(`mock-media-missing:${ref}`)
    const media = this.content.media.find((m) => m.ref === ref)
    return {
      bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      contentType: media?.contentType ?? 'application/octet-stream',
    }
  }

  /* SourceWriteProvider face */
  async readSourceHash(sourceUrl: string): Promise<string> {
    void sourceUrl
    if (this._failNextRead) {
      this._failNextRead = false
      throw new Error('mock-source-unavailable')
    }
    return this.fingerprintOf(this.content)
  }

  async pushWriteBack(
    sourceUrl: string,
    content: { title: string; body: string },
  ): Promise<{ externalRef: string; sourceSyncSha256: string }> {
    if (this._failNextPush) {
      this._failNextPush = false
      throw new Error('mock-source-unavailable')
    }
    // The push REPLACES the source's content with the Blogman content.
    const next: SourceContent = { title: content.title, markdown: content.body, media: [] }
    this.content = next
    const sourceSyncSha256 = this.fingerprintOf(next)
    this.pushed.push({ sourceUrl, title: content.title, body: content.body })
    return { externalRef: `wb:${this.pushed.length}`, sourceSyncSha256 }
  }

  get pushCount(): number {
    return this.pushed.length
  }

  get lastPush(): { sourceUrl: string; title: string; body: string } | undefined {
    return this.pushed[this.pushed.length - 1]
  }

  /** Convenience media facts for seeding a matching baseline. */
  baselineMediaFacts(): MediaSyncFact[] {
    return this.mediaFactsOf(this.content)
  }
}

/** Re-export the simple single-face mocks from earlier batches (consume). */
export { MockMediaStore, MockSourceProvider } from '@/lib/source-sync'
export { MockSourceWriteProvider } from '@/lib/source-writeback'