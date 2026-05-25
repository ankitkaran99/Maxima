import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function basePath(...segments: string[]) {
  return path.resolve(process.env.MAXIMA_BASE_PATH ?? process.cwd(), ...segments)
}

function applicationRoot() {
  const root = basePath()
  if (!fs.existsSync(path.join(root, 'config')) && fs.existsSync(path.join(root, 'src', 'config'))) {
    return path.join(root, 'src')
  }
  return root
}

export function appPath(...segments: string[]) {
  return basePath('app', ...segments)
}

export function configPath(...segments: string[]) {
  return basePath('config', ...segments)
}

export function databasePath(...segments: string[]) {
  return basePath('database', ...segments)
}

export function resourcePath(...segments: string[]) {
  return basePath('resources', ...segments)
}

export function storagePath(...segments: string[]) {
  return path.resolve(applicationRoot(), 'storage', ...segments)
}

export function publicPath(...segments: string[]) {
  return basePath('public', ...segments)
}

export function toFileUrl(file: string) {
  return pathToFileURL(file).href
}

export function dirname(metaUrl: string) {
  return path.dirname(fileURLToPath(metaUrl))
}
