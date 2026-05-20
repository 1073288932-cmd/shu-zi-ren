// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LipSyncController } from '../src/services/lipsync/LipSyncController'
import type { MouthState } from '../shared/types'

describe('LipSyncController', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('start() emits speaking states for CJK text via interval', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好', s => states.push(s))

    vi.advanceTimersByTime(110)  // 1 tick
    expect(states).toHaveLength(1)
    expect(states[0].shape).not.toBe('closed')
    expect(states[0].intensity).toBeGreaterThan(0)

    vi.advanceTimersByTime(110)  // 2nd tick
    expect(states).toHaveLength(2)

    ctrl.stop()
  })

  it('punctuation produces closed pause across multiple frames', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('好。', s => states.push(s))

    vi.advanceTimersByTime(110)   // tick 1: '好' → speaking
    vi.advanceTimersByTime(110)   // tick 2: '。' → closed trigger (pauseFrames set)
    vi.advanceTimersByTime(110)   // tick 3: pause frame
    vi.advanceTimersByTime(110)   // tick 4: pause frame

    expect(states[0].shape).not.toBe('closed')
    expect(states[1].shape).toBe('closed')
    expect(states[1].intensity).toBe(0)
    expect(states[2].shape).toBe('closed')

    ctrl.stop()
  })

  it('stop() emits {shape:closed, intensity:0} immediately and clears interval', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好世界', s => states.push(s))

    vi.advanceTimersByTime(110)  // 1 tick
    const before = states.length

    ctrl.stop()
    expect(states).toHaveLength(before + 1)
    expect(states[states.length - 1]).toEqual({ shape: 'closed', intensity: 0 })

    vi.advanceTimersByTime(2000)  // no more ticks
    expect(states).toHaveLength(before + 1)
  })

  it('stop() before any tick still emits closed state and clears', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好', s => states.push(s))

    ctrl.stop()
    expect(states).toHaveLength(1)
    expect(states[0]).toEqual({ shape: 'closed', intensity: 0 })

    vi.advanceTimersByTime(2000)
    expect(states).toHaveLength(1)
  })

  it('loops continuously without stop(): keeps emitting after text exhausted', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你', s => states.push(s))  // single char

    // Advance well past one loop worth of time
    vi.advanceTimersByTime(110 * 5)

    expect(states.length).toBeGreaterThanOrEqual(5)

    ctrl.stop()
  })

  it('second start() stops first loop and begins fresh', () => {
    const ctrl = new LipSyncController()
    const states1: MouthState[] = []
    const states2: MouthState[] = []

    ctrl.start('你好', s => states1.push(s))
    vi.advanceTimersByTime(110)  // 1 tick from first

    ctrl.start('世界', s => states2.push(s))
    // stop() was called internally: last state1 entry must be closed
    expect(states1[states1.length - 1]).toEqual({ shape: 'closed', intensity: 0 })

    vi.advanceTimersByTime(110)  // 1 tick from second
    expect(states2).toHaveLength(1)
    expect(states2[0].shape).not.toBe('closed')
  })

  it('intensity is always in [0, 1] across all character types', () => {
    const ctrl = new LipSyncController()
    const states: MouthState[] = []
    ctrl.start('你好 Hello, world! 再见。', s => states.push(s))

    vi.advanceTimersByTime(110 * 30)
    ctrl.stop()

    for (const s of states) {
      expect(s.intensity).toBeGreaterThanOrEqual(0)
      expect(s.intensity).toBeLessThanOrEqual(1)
    }
  })

  it('ASCII chars produce lower intensity than CJK', () => {
    const ctrl = new LipSyncController()
    const cjkStates: MouthState[] = []
    const asciiStates: MouthState[] = []

    const cjkCtrl = new LipSyncController()
    cjkCtrl.start('你好世界', s => cjkStates.push(s))
    vi.advanceTimersByTime(110 * 4)
    cjkCtrl.stop()

    const asciiCtrl = new LipSyncController()
    asciiCtrl.start('abcd', s => asciiStates.push(s))
    vi.advanceTimersByTime(110 * 4)
    asciiCtrl.stop()

    const cjkAvg = cjkStates
      .filter(s => s.shape !== 'closed')
      .reduce((sum, s) => sum + s.intensity, 0) / cjkStates.filter(s => s.shape !== 'closed').length

    const asciiAvg = asciiStates
      .filter(s => s.shape !== 'closed')
      .reduce((sum, s) => sum + s.intensity, 0) / asciiStates.filter(s => s.shape !== 'closed').length

    expect(asciiAvg).toBeLessThan(cjkAvg)
  })
})
