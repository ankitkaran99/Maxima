import { ServiceProvider } from '@lib/container/Container.js'
import { DatabaseManager } from '@lib/database/DB.js'
import { FilesystemManager } from '@lib/storage/Storage.js'
import { currentTenant } from './TenantContext.js'
import { storagePath } from '@lib/support/paths.js'
import { TenantMiddleware } from './TenantMiddleware.js'
import path from 'node:path'
import fsSync from 'node:fs'

export class TenantServiceProvider extends ServiceProvider {
  register() {
    const configRepo = (this.app as any).config
    const originalGet = configRepo.get.bind(configRepo)

    // Load dynamic tenancy configuration defaults if not present
    if (!configRepo.has('tenancy')) {
      configRepo.set('tenancy', {
        identification: 'subdomain',
        central_domains: ['localhost', '127.0.0.1'],
        abort_on_fail: true,
        tenants: []
      })
    }

    // 1. Intercept config lookups
    configRepo.get = (key: string, defaultValue?: any) => {
      const tenant = currentTenant()
      if (!tenant) {
        return originalGet(key, defaultValue)
      }

      // Intercept database connection config
      if (key.startsWith('database.connections.')) {
        const connName = key.slice('database.connections.'.length)
        
        if (connName.startsWith(`tenant_${tenant.id}_`)) {
          const originalConnName = connName.slice(`tenant_${tenant.id}_`.length)
          const originalConnConfig = originalGet(`database.connections.${originalConnName}`) as any
          
          if (!originalConnConfig) {
            return undefined
          }

          const tenantDbConfig = tenant.config.database || {}
          const mergedConfig = {
            ...originalConnConfig,
            ...tenantDbConfig,
            connection: typeof originalConnConfig.connection === 'object' && typeof tenantDbConfig.connection === 'object'
              ? { ...originalConnConfig.connection, ...tenantDbConfig.connection }
              : (tenantDbConfig.connection ?? originalConnConfig.connection)
          }

          // SQLite filename isolation
          if (mergedConfig.client === 'sqlite3' || mergedConfig.client === 'better-sqlite3' || mergedConfig.client === 'sqlite') {
            if (typeof mergedConfig.connection === 'object' && (!tenantDbConfig.connection || !tenantDbConfig.connection.filename)) {
              const dbFile = storagePath('tenants', tenant.id, 'database.sqlite')
              console.log('SQLITE DB FILE:', dbFile)
              fsSync.mkdirSync(path.dirname(dbFile), { recursive: true })
              console.log('SQLITE DB DIR CREATED:', fsSync.existsSync(path.dirname(dbFile)))
              mergedConfig.connection = {
                ...mergedConfig.connection,
                filename: dbFile
              }
              console.log('MERGED CONFIG:', mergedConfig)
            }
          } else {
            // Suffix database name for other database clients
            if (typeof mergedConfig.connection === 'object' && mergedConfig.connection && (!tenantDbConfig.connection || !tenantDbConfig.connection.database)) {
              const baseDb = originalConnConfig.connection?.database || 'maxima'
              mergedConfig.connection = {
                ...mergedConfig.connection,
                database: `${baseDb}_tenant_${tenant.id}`
              }
            }
          }

          return mergedConfig
        }
      }

      // Intercept filesystems disks config
      if (key.startsWith('filesystems.disks.')) {
        const diskName = key.slice('filesystems.disks.'.length)
        
        if (diskName.startsWith(`tenant_${tenant.id}_`)) {
          const originalDiskName = diskName.slice(`tenant_${tenant.id}_`.length)
          const originalDiskConfig = originalGet(`filesystems.disks.${originalDiskName}`) as any
          
          if (!originalDiskConfig) {
            return undefined
          }

          const tenantDiskConfig = tenant.config.storage?.disks?.[originalDiskName] || {}
          
          const mergedDiskConfig = {
            ...originalDiskConfig,
            ...tenantDiskConfig
          }

          // Apply automatic scoping for local driver
          if (!tenantDiskConfig.root && (mergedDiskConfig.driver === 'local')) {
            const originalRoot = originalDiskConfig.root || storagePath('app')
            const baseDir = path.basename(originalRoot)
            mergedDiskConfig.root = storagePath('tenants', tenant.id, baseDir)

            // Scope URL for public disk
            if (originalDiskName === 'public' && originalDiskConfig.url) {
              const originalUrl = originalDiskConfig.url
              mergedDiskConfig.url = `${originalUrl}/tenants/${tenant.id}`
            }
          } else if (!tenantDiskConfig.prefix && ['s3', 'ftp', 'sftp', 'ssh'].includes(mergedDiskConfig.driver)) {
            // Use scoped driver to wrap remote disk
            return {
              driver: 'scoped',
              disk: originalDiskName,
              prefix: `tenants/${tenant.id}`
            }
          }

          return mergedDiskConfig
        }
      }

      return originalGet(key, defaultValue)
    }

    // 2. Wrap DatabaseManager.prototype.connection
    const originalConnection = DatabaseManager.prototype.connection
    DatabaseManager.prototype.connection = function(name?: string) {
      const tenant = currentTenant()
      if (tenant) {
        const baseName = name || originalGet('database.default', 'sqlite')
        if (baseName.startsWith(`tenant_${tenant.id}_`)) {
          return originalConnection.call(this, baseName)
        }
        const scopedName = `tenant_${tenant.id}_${baseName}`
        return originalConnection.call(this, scopedName)
      }
      return originalConnection.call(this, name)
    }

    // 3. Wrap FilesystemManager.prototype.disk
    const originalDisk = FilesystemManager.prototype.disk
    FilesystemManager.prototype.disk = function(name?: string) {
      const tenant = currentTenant()
      if (tenant) {
        const baseName = name || originalGet('filesystems.default', 'local')
        if (baseName.startsWith(`tenant_${tenant.id}_`)) {
          return originalDisk.call(this, baseName)
        }
        const scopedName = `tenant_${tenant.id}_${baseName}`
        return originalDisk.call(this, scopedName)
      }
      return originalDisk.call(this, name)
    }
  }

  boot() {
    const aliases = (this.app as any).config.get('middleware.aliases') as any
    if (aliases && !aliases.tenant) {
      aliases.tenant = TenantMiddleware
    }
  }
}
