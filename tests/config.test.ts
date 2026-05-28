import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigRepository } from '@lib/config/ConfigRepository.js'
import { EnvRepository } from '@lib/config/Env.js'

const tempRoots: string[] = []
const originalBasePath = process.env.MAXIMA_BASE_PATH

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-config-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  process.env.MAXIMA_BASE_PATH = originalBasePath
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('Configuration', () => {
  it('loads env files with process env taking precedence and coerces primitive values', async () => {
    const root = await makeTempRoot()
    const envFile = path.join(root, '.env')
    await fs.writeFile(envFile, [
      'APP_NAME=FromFile',
      'APP_PORT=3000',
      'APP_DEBUG=true',
      'APP_DISABLED=false'
    ].join('\n'))

    process.env.APP_NAME = 'FromProcess'
    const env = new EnvRepository()
    env.load(envFile)
    delete process.env.APP_NAME

    expect(env.get('APP_NAME')).toBe('FromProcess')
    expect(env.get('APP_PORT')).toBe(3000)
    expect(env.get('APP_DEBUG')).toBe(true)
    expect(env.get('APP_DISABLED')).toBe(false)
    expect(env.get('MISSING', 'fallback')).toBe('fallback')
  })

  it('loads config files and resolves dot paths', async () => {
    const root = await makeTempRoot()
    const configDir = path.join(root, 'config')
    await fs.mkdir(configDir)
    await fs.writeFile(path.join(configDir, 'app.js'), 'export default { name: "Maxima", http: { port: 3000 } }\n')
    await fs.writeFile(path.join(configDir, 'types.d.ts'), 'export default { broken: true }\n')

    const config = new ConfigRepository()
    await config.load(configDir)
    config.set('app.http.host', '127.0.0.1')

    expect(config.get('app.name')).toBe('Maxima')
    expect(config.get('app.http.port')).toBe(3000)
    expect(config.get('app.http.host')).toBe('127.0.0.1')
    expect(config.has('app.http.host')).toBe(true)
    expect(config.get('app.missing', 'fallback')).toBe('fallback')
    expect(config.has('types')).toBe(false)
  })

  it('loads cached config before source config files', async () => {
    const root = await makeTempRoot()
    process.env.MAXIMA_BASE_PATH = root
    const configDir = path.join(root, 'config')
    const cacheDir = path.join(root, 'storage', 'framework')
    await fs.mkdir(configDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'app.js'), 'export default { name: "FromSource" }\n')
    await fs.writeFile(path.join(cacheDir, 'config.json'), JSON.stringify({ app: { name: 'FromCache' } }))

    const config = new ConfigRepository()
    await config.load(configDir)

    expect(config.get('app.name')).toBe('FromCache')
  })

  it('writes a config cache file', async () => {
    const root = await makeTempRoot()
    const target = path.join(root, 'storage', 'framework', 'config.json')
    const config = new ConfigRepository()
    config.set('app.name', 'Maxima')

    await config.cache(target)

    await expect(fs.readFile(target, 'utf8')).resolves.toContain('"Maxima"')
  })
})
