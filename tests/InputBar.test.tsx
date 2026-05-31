import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useAgentStore, initialState } from '../src/store/agentStore'

// 受控 asr mock：捕获 InputBar 注册的 onError 回调，供测试触发
const asrHandlers = vi.hoisted(() => ({ error: undefined as ((code: string) => void) | undefined }))
vi.mock('../src/services/asr', () => ({
  asrProvider: {
    available: true,
    start: vi.fn(),
    stop: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn((cb: (code: string) => void) => { asrHandlers.error = cb }),
    onEnd: vi.fn(),
  },
}))

import { InputBar } from '../src/components/InputBar'

describe('InputBar ASR error surfacing', () => {
  beforeEach(() => {
    useAgentStore.setState(initialState)
    asrHandlers.error = undefined
  })

  it('shows a friendly message when ASR returns ASR_UNAVAILABLE (no silent swallow)', () => {
    const utils = render(<InputBar sendMessage={vi.fn()} retry={vi.fn()} />)
    expect(asrHandlers.error).toBeTypeOf('function')
    act(() => { asrHandlers.error!('ASR_UNAVAILABLE') })
    expect(utils.getByText('语音识别未配置')).toBeTruthy()
  })

  it('maps permission-denied to a permission hint', () => {
    const utils = render(<InputBar sendMessage={vi.fn()} retry={vi.fn()} />)
    act(() => { asrHandlers.error!('permission-denied') })
    expect(utils.getByText(/麦克风权限/)).toBeTruthy()
  })

  it('falls back to a generic message for unknown error codes', () => {
    const utils = render(<InputBar sendMessage={vi.fn()} retry={vi.fn()} />)
    act(() => { asrHandlers.error!('SOME_WEIRD_CODE') })
    expect(utils.getByText('语音识别失败，请重试')).toBeTruthy()
  })
})
