import { DB } from '@lib/database/DB.js'
import { databasePath } from '@lib/support/paths.js'
import { TenantManager } from '../TenantManager.js'
import { runWithTenant } from '../TenantContext.js'

export class TenantMigrateCommand {
  signature = 'tenant:migrate {--tenant= : Specific tenant ID to migrate} {--path= : Custom path to migrations folder}'
  description = 'Run migrations for tenant databases'

  async handle(options: { tenant?: string, path?: string }) {
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
      console.log('INFO  No tenants found to migrate.')
      return
    }

    const migrationDir = options.path ? options.path : databasePath('migrations')

    for (const tenant of tenants) {
      console.log(`INFO  Migrating tenant: [${tenant.id}]`)
      try {
        await runWithTenant(tenant, async () => {
          await DB.connection().migrate.latest({
            directory: migrationDir
          })
        })
        console.log(`SUCCESS  Successfully migrated tenant: [${tenant.id}]`)
      } catch (error: any) {
        console.error(`ERROR  Failed to migrate tenant [${tenant.id}]:`, error.message)
      }
    }
  }
}
