import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LipSyncController, STEP_INTERVAL } from '../src/services/lipsync/LipSyncController'
import type { Viseme } from '@shared/types'

describe('LipSyncController', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('emits the first viseme immediately on start()', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好', v => seen.push(v))
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe('closed')  // 你 → i
    ctrl.stop()
  })

  it('advances one viseme per STEP_INTERVAL', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好世界', v => seen.push(v))  // 4 visemes
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(STEP_INTERVAL)
    expect(seen).toHaveLength(2)
    vi.advanceTimersByTime(STEP_INTERVAL)
    expect(seen).toHaveLength(3)
    ctrl.stop()
  })

  it('loops the sequence after it is exhausted', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你', v => seen.push(v))  // single viseme
    vi.advanceTimersByTime(STEP_INTERVAL * 4)
    expect(seen.length).toBeGreaterThanOrEqual(5)
    expect(new Set(seen).size).toBe(1)  // looped same viseme
    ctrl.stop()
  })

  it('stop() clears the interval and emits closed', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好世界', v => seen.push(v))
    const before = seen.length
    ctrl.stop()
    expect(seen[seen.length - 1]).toBe('closed')
    vi.advanceTimersByTime(STEP_INTERVAL * 5)
    expect(seen.length).toBe(before + 1)  // no emissions after stop
  })

  it('start() then immediate stop() (no tick) still ends on closed', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('你好', v => seen.push(v))
    ctrl.stop()
    expect(seen[seen.length - 1]).toBe('closed')
  })

  it('second start() stops the first loop; old callback receives closed', () => {
    const ctrl = new LipSyncController()
    const first: Viseme[] = []
    const second: Viseme[] = []
    ctrl.start('你好', v => first.push(v))
    vi.advanceTimersByTime(STEP_INTERVAL)
    ctrl.start('世界', v => second.push(v))
    expect(first[first.length - 1]).toBe('closed')
    vi.advanceTimersByTime(STEP_INTERVAL)
    expect(second.length).toBeGreaterThanOrEqual(2)
    ctrl.stop()
  })

  it('emits closed for empty text and does not re-emit on stop()', () => {
    const ctrl = new LipSyncController()
    const seen: Viseme[] = []
    ctrl.start('', v => seen.push(v))
    expect(seen).toEqual(['closed'])
    ctrl.stop()
    expect(seen).toEqual(['closed'])  // 空文本 start 已清空 onViseme — stop 不再重复 emit
  })
})
