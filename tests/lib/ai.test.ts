import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
}))

vi.mock('openai', () => ({
  default: function OpenAI() {
    return {
      chat: {
        completions: {
          create: mocks.createCompletion,
        },
      },
    }
  },
}))

import { transformEditorSelectionStream } from '@/lib/ai'

function buildResponse(options: {
  content?: string
  reasoning_content?: string
  finish_reason?: string | null
}) {
  return {
    choices: [
      {
        message: {
          ...(options.content !== undefined ? { content: options.content } : {}),
          ...(options.reasoning_content !== undefined ? { reasoning_content: options.reasoning_content } : {}),
        },
        finish_reason: options.finish_reason ?? null,
      },
    ],
  }
}

async function readStreamText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
  }

  output += decoder.decode()
  return output
}

describe('ai transformEditorSelectionStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retries when the provider returns reasoning only before the final answer', async () => {
    mocks.createCompletion
      .mockResolvedValueOnce(buildResponse({
        reasoning_content: '分析问题中',
        finish_reason: 'length',
      }))
      .mockResolvedValueOnce(buildResponse({
        content: '处理后的最终答案',
        finish_reason: 'stop',
      }))

    const stream = await transformEditorSelectionStream('原始文本', 'custom', {
      customPrompt: '请润色这段文本',
      env: {
        AI_API_KEY: 'test-key',
        AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
        AI_MODEL: 'glm-5.1',
      },
    })

    await expect(readStreamText(stream)).resolves.toBe('处理后的最终答案')
    expect(mocks.createCompletion).toHaveBeenCalledTimes(2)
  })
})
