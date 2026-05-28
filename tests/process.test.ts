import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, childMock } = vi.hoisted(() => {
  const childMock = {
    stdout: {
      on: vi.fn()
    },
    stderr: {
      on: vi.fn()
    },
    stdin: {
      end: vi.fn()
    },
    on: vi.fn(),
    kill: vi.fn()
  }

  const spawnMock = vi.fn(() => childMock)
  return { spawnMock, childMock }
})

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { Process } from '@lib/process/Process.js'

describe('Process Manager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Process.restore()
    spawnMock.mockClear()
    childMock.stdout.on.mockClear()
    childMock.stderr.on.mockClear()
    childMock.stdin.end.mockClear()
    childMock.on.mockClear()
    childMock.kill.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    Process.restore()
  })

  it('clears timeout timers after a process exits', async () => {
    const pending = Process.command('node', ['-v']).timeout(1)
    const run = pending.run()

    expect(spawnMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)

    const closeHandler = childMock.on.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(closeHandler).toBeTypeOf('function')
    closeHandler(0)

    await run
    expect(vi.getTimerCount()).toBe(0)
    expect(childMock.kill).not.toHaveBeenCalled()
  })
})
