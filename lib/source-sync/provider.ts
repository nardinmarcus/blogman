/**
 * B6-02 — 源稿领先同步 provider / media-store layer (issue #51).
 *
 * The interface real source readers and real R2 wiring implement later. THIS
 * BATCH SHIPS THE MOCK ONLY and zero production wiring (零生产, 不真拉源稿,
 * 不真写 R2): production passes no adapters, so the sync only ever runs
 * against injected in-memory mocks in tests. The mocks make every failure
 * branch provable — a failing media read, a failing media put, and a source
 * that is simply behind Blogman (content equal to the baseline).
 */

import type { MediaStore, SourceContent, SourceMediaBytes, SourceMediaRef, SourceProvider } from './types'

/** An in-memory source holding canned title + Markdown + media by ref. */
export class MockSourceProvider implements SourceProvider {
  readonly kind = 'mock-source'
  totalCalls = 0
  reads: Record<string, Buffer> = {}
  private content: SourceContent
  private readFailures: string[] = []
  private mediaFailures: string[] = []
  private sequence: Array<SourceContent | Error> = []

  constructor(content: SourceContent) {
    this.content = content
  }

  /** Add or override the raw bytes for one media ref. */
  setMediaBytes(ref: string, bytes: Buffer | Uint8Array): this {
    this.reads[ref] = Buffer.from(bytes)
    return this
  }

  /** Queue a canned source snapshot for the NEXT read (shifted in order). */
  queueRead(next: SourceContent): this {
    this.sequence.push(next)
    return this
  }

  /** Make readSource() throw for the next call(s). */
  failRead(): this {
    this.sequence.push(new Error('mock-read-failure'))
    return this
  }

  /** Make readMediaBytes(ref) throw for the given ref. */
  failMedia(ref: string): this {
    this.mediaFailures.push(ref)
    return this
  }

  async readSource(): Promise<SourceContent> {
    this.totalCalls += 1
    const next = this.sequence.shift()
    if (next instanceof Error) throw next
    if (next) return next
    return this.content
  }

  async readMediaBytes(ref: string): Promise<SourceMediaBytes> {
    if (this.mediaFailures.includes(ref)) {
      throw new Error(`mock-media-read-failure:${ref}`)
    }
    const bytes = this.reads[ref]
    if (!bytes) throw new Error(`mock-media-missing:${ref}`)
    const media = this.mediaFor(ref)
    return {
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType: media?.contentType ?? 'application/octet-stream',
    }
  }

  private mediaFor(ref: string): SourceMediaRef | undefined {
    return this.content.media.find((m) => m.ref === ref)
  }
}

/** An in-memory R2-isomorphic media sink recording every put by r2Key. */
export class MockMediaStore implements MediaStore {
  readonly kind = 'mock-media-store'
  readonly objects = new Map<string, Buffer>()
  /** Keys for which `put` should throw (MediaStore failure injection). */
  private putFailures = new Set<string>()
  /** A blanket failure flag: when true every put throws. */
  failAll = false

  putFail(key: string): this {
    this.putFailures.add(key)
    return this
  }

  async put(opts: { r2Key: string; bytes: ArrayBuffer; contentType: string; filename: string }): Promise<void> {
    if (this.failAll || this.putFailures.has(opts.r2Key)) {
      throw new Error(`mock-media-put-failure:${opts.r2Key}`)
    }
    this.objects.set(opts.r2Key, Buffer.from(opts.bytes))
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }

  get objectCount(): number {
    return this.objects.size
  }
}
