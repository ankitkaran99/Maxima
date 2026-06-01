import { fileURLToPath } from 'node:url'
import { defineConfig, configDefaults } from 'vitest/config'

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@lib': resolvePath('./lib'),
      '@src': resolvePath('./src'),
      '@app': resolvePath('./src/app'),
      '@plugins': resolvePath('./plugins')
    }
  },
  test: {
    exclude: [...configDefaults.exclude, 'dist/**']
  }
})
