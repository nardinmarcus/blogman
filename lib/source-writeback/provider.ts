/**
 * B6-03 — 显式写回: external primary-source provider + test mock (issue #52).
 *
 * The write-back kernel NEVER talks to a real source: it depends on a
 * `SourceWriteProvider`. B6-03 ships only the boundary plus a controllable
 * in-memory mock (zero production, provider mock), so the confirmation-gated
 * baseline logic is exercised deterministically in tests.
 */

import type { SourceWriteProvider } from './types'

export type { SourceWriteProvider } from './types'

/** A controllable in-memory fake backing a single primary-source URL. */
export class MockSourceWriteProvider implements SourceWriteProvider {
  private currentHash: string
  private pushes: Array<{ sourceUrl: string; title: string; body: string }> = []
  private hashSource: (content: { title: string; body: string }) => string
  private _failNextRead = false
  private _failNextPush = false

  constructor(initialHash: string, hashSource: (content: { title: string; body: string }) => string) {
    this.currentHash = initialHash
    this.hashSource = hashSource
  }

  /** Read the hash the primary source currently holds. */
  async readSourceHash(sourceUrl: string): Promise<string> {
    void sourceUrl
    if (this._failNextRead) {
      this._failNextRead = false
      throw new Error('primary source device unavailable')
    }
    return this.currentHash
  }

  /** Push blogman content; stores it and returns its new source hash + a ref. */
  async pushWriteBack(
    sourceUrl: string,
    content: { title: string; body: string },
  ): Promise<{ externalRef: string; sourceSyncSha256: string }> {
    if (this._failNextPush) {
      this._failNextPush = false
      throw new Error('primary source device unavailable')
    }
    const sourceSyncSha256 = this.hashSource(content)
    this.currentHash = sourceSyncSha256
    this.pushes.push({ sourceUrl, title: content.title, body: content.body })
    return { externalRef: `wb:${this.pushes.length}`, sourceSyncSha256 }
  }

  /** Simulate the source/device being unavailable on the NEXT readSourceHash call. */
  failNextRead(): void {
    this._failNextRead = true
  }

  /** Simulate the source/device being unavailable on the NEXT pushWriteBack call. */
  failNextPush(): void {
    this._failNextPush = true
  }

  /** Manually mutate the source-side hash (simulates source divergence). */
  setSourceHash(hash: string): void {
    this.currentHash = hash
  }

  get pushCount(): number {
    return this.pushes.length
  }

  get lastPush(): { sourceUrl: string; title: string; body: string } | undefined {
    return this.pushes[this.pushes.length - 1]
  }
}
