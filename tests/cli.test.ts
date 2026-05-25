import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCliCommand } from '@lib/cli/runCliCommand.js'

describe('CLI', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-cli-'))
    process.env.MAXIMA_BASE_PATH = root
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    process.env.MAXIMA_BASE_PATH = originalBasePath
    await fs.rm(root, { recursive: true, force: true })
  })

  it('creates framework files in the project source tree', async () => {
    await runCliCommand(['make:model', 'User'])
    await runCliCommand(['make:controller', 'UserController'])

    const model = await fs.readFile(path.join(root, 'src', 'app', 'Models', 'User.ts'), 'utf8')
    const controller = await fs.readFile(path.join(root, 'src', 'app', 'Http', 'Controllers', 'UserController.ts'), 'utf8')

    expect(model).toContain('export default class User extends Model')
    expect(controller).toContain('export default class UserController extends Controller')
  })
})
