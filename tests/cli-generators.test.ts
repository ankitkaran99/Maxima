import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { runCliCommand } from '@lib/cli/runCliCommand.js'

describe('CLI Generators', () => {
  const root = path.join(process.cwd(), 'src')

  beforeEach(async () => {
    // Clean up any test generated files if they exist
    for (const file of [
      'app/Policies/TestPolicy.ts',
      'app/Events/TestEvent.ts',
      'app/Listeners/TestListener.ts',
      'app/Http/Resources/TestResource.ts',
      'app/Casts/TestCast.ts',
      'app/Console/Commands/TestCommand.ts',
      'database/seeders/TestSeeder.ts',
      'database/factories/TestFactory.ts'
    ]) {
      await fs.rm(path.join(root, file), { force: true })
    }
  })

  afterEach(async () => {
    for (const file of [
      'app/Policies/TestPolicy.ts',
      'app/Events/TestEvent.ts',
      'app/Listeners/TestListener.ts',
      'app/Http/Resources/TestResource.ts',
      'app/Casts/TestCast.ts',
      'app/Console/Commands/TestCommand.ts',
      'database/seeders/TestSeeder.ts',
      'database/factories/TestFactory.ts'
    ]) {
      await fs.rm(path.join(root, file), { force: true })
    }
  })

  it('generates policy, event, listener, resource, cast, and custom command files', async () => {
    // Generate policy
    await runCliCommand(['make:policy', 'TestPolicy'])
    expect(fsSync.existsSync(path.join(root, 'app/Policies/TestPolicy.ts'))).toBe(true)
    const policyContent = await fs.readFile(path.join(root, 'app/Policies/TestPolicy.ts'), 'utf8')
    expect(policyContent).toContain('class TestPolicy')

    // Generate event
    await runCliCommand(['make:event', 'TestEvent'])
    expect(fsSync.existsSync(path.join(root, 'app/Events/TestEvent.ts'))).toBe(true)
    const eventContent = await fs.readFile(path.join(root, 'app/Events/TestEvent.ts'), 'utf8')
    expect(eventContent).toContain('class TestEvent')

    // Generate listener
    await runCliCommand(['make:listener', 'TestListener'])
    expect(fsSync.existsSync(path.join(root, 'app/Listeners/TestListener.ts'))).toBe(true)
    const listenerContent = await fs.readFile(path.join(root, 'app/Listeners/TestListener.ts'), 'utf8')
    expect(listenerContent).toContain('class TestListener')

    // Generate resource
    await runCliCommand(['make:resource', 'TestResource'])
    expect(fsSync.existsSync(path.join(root, 'app/Http/Resources/TestResource.ts'))).toBe(true)
    const resourceContent = await fs.readFile(path.join(root, 'app/Http/Resources/TestResource.ts'), 'utf8')
    expect(resourceContent).toContain('class TestResource extends JsonResource')

    // Generate cast
    await runCliCommand(['make:cast', 'TestCast'])
    expect(fsSync.existsSync(path.join(root, 'app/Casts/TestCast.ts'))).toBe(true)
    const castContent = await fs.readFile(path.join(root, 'app/Casts/TestCast.ts'), 'utf8')
    expect(castContent).toContain('class TestCast implements CastsAttributes')

    // Generate custom command
    await runCliCommand(['make:command', 'TestCommand'])
    expect(fsSync.existsSync(path.join(root, 'app/Console/Commands/TestCommand.ts'))).toBe(true)
    const commandContent = await fs.readFile(path.join(root, 'app/Console/Commands/TestCommand.ts'), 'utf8')
    expect(commandContent).toContain('class TestCommand')

    // Generate seeder
    await runCliCommand(['make:seeder', 'TestSeeder'])
    expect(fsSync.existsSync(path.join(root, 'database/seeders/TestSeeder.ts'))).toBe(true)
    const seederContent = await fs.readFile(path.join(root, 'database/seeders/TestSeeder.ts'), 'utf8')
    expect(seederContent).toContain('export async function seed')

    // Generate factory
    await runCliCommand(['make:factory', 'TestFactory'])
    expect(fsSync.existsSync(path.join(root, 'database/factories/TestFactory.ts'))).toBe(true)
    const factoryContent = await fs.readFile(path.join(root, 'database/factories/TestFactory.ts'), 'utf8')
    expect(factoryContent).toContain('class TestFactory')
  })
})
