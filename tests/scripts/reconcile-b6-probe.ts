/**
 * B6-G — controllable availability probe mock (issue #56).
 *
 * In-memory `SourceProbe` that replays a predetermined queue of read outcomes.
 * Mirrors the private MockProbe of the B6-05 kernel tests. Zero production.
 */

import type { ProbeReadOutcome, SourceProbe } from '@/lib/source-availability'

export class MockSourceProbe implements SourceProbe {
  private queue: ProbeReadOutcome[] = []
  calls = 0
  constructor(initial: ProbeReadOutcome[] = []) {
    this.queue = [...initial]
  }
  async readSource(): Promise<ProbeReadOutcome> {
    this.calls += 1
    const next = this.queue.shift()
    if (next) return next
    return { outcome: 'readable' }
  }
  push(...o: ProbeReadOutcome[]): void {
    this.queue.push(...o)
  }
}
