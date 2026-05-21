import { describe, it, expect, vi } from 'vitest'
import { validateSsml, runAvatarSegmentJob, type JobDeps, type JobEvents } from '../electron/services/avatarVideoHandler'

describe('validateSsml', () => {
  it('rejects non-string', () => {
    expect(validateSsml(42 as unknown).ok).toBe(false)
    expect(validateSsml(null).ok).toBe(false)
    expect(validateSsml(undefined).ok).toBe(false)
  })
  it('rejects empty / whitespace', () => {
    expect(validateSsml('').ok).toBe(false)
    expect(validateSsml('   ').ok).toBe(false)
  })
  it('rejects >300 chars', () => {
    expect(validateSsml('a'.repeat(301)).ok).toBe(false)
  })
  it('rejects control chars (\\x00)', () => {
    expect(validateSsml('hello\x00world').ok).toBe(false)
  })
  it('accepts valid Chinese ssml', () => {
    const r = validateSsml('你好，物理世界。')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('你好，物理世界。')
  })
  it('trims leading/trailing whitespace', () => {
    const r = validateSsml('  hi  ')
    expect(r.ok && r.value).toBe('hi')
  })
})

describe('runAvatarSegmentJob', () => {
  function makeDeps(overrides: Partial<JobDeps> = {}): JobDeps {
    return {
      getRefPhotoUrl: vi.fn().mockResolvedValue('https://ref'),
      submitTask: vi.fn().mockResolvedValue('task-1'),
      pollUntilDone: vi.fn().mockImplementation(async (_id, _signal, onAttempt) => {
        onAttempt(1); return 'https://video'
      }),
      downloadVideo: vi.fn().mockResolvedValue({
        buffer: new ArrayBuffer(8), mimeType: 'video/mp4',
      }),
      ...overrides,
    }
  }
  function makeEvents(): JobEvents & { collected: any[] } {
    const collected: any[] = []
    return {
      collected,
      progress: e => collected.push(['p', e]),
      done: e => collected.push(['d', e]),
      error: e => collected.push(['e', e]),
    }
  }

  it('emits submitting → polling → downloading → done on happy path', async () => {
    const deps = makeDeps()
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j1', ssml: '你好' }, deps, events, new AbortController())
    const stages = events.collected.filter(([t]) => t === 'p').map(([_, e]) => e.stage)
    expect(stages).toEqual(['submitting', 'polling', 'downloading'])
    const dones = events.collected.filter(([t]) => t === 'd')
    expect(dones).toHaveLength(1)
    expect(dones[0][1]).toMatchObject({ jobId: 'j1', mimeType: 'video/mp4' })
    expect(events.collected.filter(([t]) => t === 'e')).toHaveLength(0)
  })

  it('emits error and stops on getRefPhotoUrl rejection (COS_NOT_READY)', async () => {
    const deps = makeDeps({
      getRefPhotoUrl: vi.fn().mockRejectedValue({ code: 'COS_NOT_READY', message: 'cos down', recoverable: false }),
    })
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j2', ssml: 't' }, deps, events, new AbortController())
    expect(deps.submitTask).not.toHaveBeenCalled()
    const errors = events.collected.filter(([t]) => t === 'e')
    expect(errors).toHaveLength(1)
    expect(errors[0][1]).toMatchObject({ jobId: 'j2', error: { code: 'COS_NOT_READY' } })
  })

  it('emits error on POLICY_VIOLATION from submit', async () => {
    const deps = makeDeps({
      submitTask: vi.fn().mockRejectedValue({ code: 'POLICY_VIOLATION', message: '审核失败', recoverable: false }),
    })
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j3', ssml: 't' }, deps, events, new AbortController())
    expect(deps.pollUntilDone).not.toHaveBeenCalled()
    expect(deps.downloadVideo).not.toHaveBeenCalled()
    const errors = events.collected.filter(([t]) => t === 'e')
    expect(errors[0][1].error.code).toBe('POLICY_VIOLATION')
  })

  it('treats abort as silent (no done/error event)', async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      submitTask: vi.fn().mockImplementation(async () => {
        controller.abort()
        throw { code: 'TENCENT_API_FAIL', message: 'aborted', recoverable: true }
      }),
    })
    const events = makeEvents()
    await runAvatarSegmentJob({ jobId: 'j4', ssml: 't' }, deps, events, controller)
    expect(events.collected.filter(([t]) => t === 'd')).toHaveLength(0)
    expect(events.collected.filter(([t]) => t === 'e')).toHaveLength(0)
  })
})
