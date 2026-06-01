import { env, databasePath, basePath } from '@lib/index.js'
import path from 'node:path'

export default {
  default: 'sqlite',
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: (() => {
          const dbFile = env<string | undefined>('DB_FILENAME')
          if (!dbFile) return databasePath('database.sqlite')
          return path.isAbsolute(String(dbFile)) ? String(dbFile) : basePath(String(dbFile))
        })()
      },
      useNullAsDefault: true,
      migrations: {
        directory: databasePath('migrations')
      },
      seeds: {
        directory: databasePath('seeders')
      }
    }
  }
}
