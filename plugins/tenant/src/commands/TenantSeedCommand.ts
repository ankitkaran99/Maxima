import { DB } from '@lib/database/DB.js'
import { projectRoot } from '@lib/support/paths.js'
import { TenantManager } from '../TenantManager.js'
import { runWithTenant } from '../TenantContext.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export class TenantSeedCommand {
  signature = 'tenant:seed {--tenant= : Specific tenant ID to seed} {--class= : Seeder class name}'
  description = 'Seed tenant databases'

  async handle(options: { tenant?: string, class?: string }) {
    let tenants = await TenantManager.all()

    if (options.tenant) {
      const selected = tenants.find(t => t.id === options.tenant)
      if (!selected) {
        console.error(`ERROR  Tenant [${options.tenant}] not found.`)
        return
      }
      tenants = [selected]
    }

    if (tenants.length === 0) {
      console.log('INFO  No tenants found to seed.')
      return
    }

    for (const tenant of tenants) {
      console.log(`INFO  Seeding tenant: [${tenant.id}]`)
      try {
        await runWithTenant(tenant, async () => {
          const connection = DB.connection()
          if (options.class) {
            const seederPath = path.join(projectRoot(), 'database', 'seeders', `${options.class}.ts`)
            const mod = await import(`${pathToFileURL(seederPath).href}?t=${Date.now()}`)
            const seed = mod.seed ?? mod.default?.seed
            if (typeof seed !== 'function') throw new Error(`Seeder [${options.class}] does not export seed().`)
            await seed(connection)
          } else {
            await connection.seed.run()
          }
        })
        console.log(`SUCCESS  Successfully seeded tenant: [${tenant.id}]`)
      } catch (error: any) {
        console.error(`ERROR  Failed to seed tenant [${tenant.id}]:`, error.message)
      }
    }
  }
}
