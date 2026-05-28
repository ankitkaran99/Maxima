import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

function applicationRoot() {
  const root = path.resolve(process.env.MAXIMA_BASE_PATH ?? process.cwd())
  if (!fs.existsSync(path.join(root, 'config')) && fs.existsSync(path.join(root, 'src', 'config'))) {
    return path.join(root, 'src')
  }
  return root
}

export function basePath(...segments: string[]) {
  return path.resolve(applicationRoot(), ...segments)
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

export function projectRoot() {
  const appRoot = applicationRoot()
  const basename = path.basename(appRoot).toLowerCase()
  if (basename === 'src') {
    const parent = path.dirname(appRoot)
    if (path.basename(parent).toLowerCase() === 'dist') {
      return path.dirname(parent)
    }
    return parent
  }
  return appRoot
}

export function resourcePath(...segments: string[]) {
  const appRoot = applicationRoot()
  if (fs.existsSync(path.join(appRoot, 'resources'))) {
    return path.resolve(appRoot, 'resources', ...segments)
  }
  const srcResources = path.resolve(projectRoot(), 'src', 'resources')
  if (fs.existsSync(srcResources)) {
    return path.resolve(srcResources, ...segments)
  }
  return path.resolve(projectRoot(), 'resources', ...segments)
}

export function storagePath(...segments: string[]) {
  return path.resolve(projectRoot(), 'storage', ...segments)
}

export function publicPath(...segments: string[]) {
  return path.resolve(projectRoot(), 'public', ...segments)
}

export function toFileUrl(file: string) {
  return pathToFileURL(file).href
}

export function dirname(metaUrl: string) {
  return path.dirname(fileURLToPath(metaUrl))
}
