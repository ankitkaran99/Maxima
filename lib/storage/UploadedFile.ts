import path from 'node:path'
import { Storage } from '@lib/storage/Storage.js'

export class UploadedFile {
  constructor(private file: { filename: string, mimetype: string, file: NodeJS.ReadableStream, bytesRead?: number }) {}
  originalName() { return this.file.filename }
  extension() { return path.extname(this.file.filename).replace('.', '') }
  mimeType() { return this.file.mimetype }
  size() { return this.file.bytesRead ?? 0 }
  path() { return this.file.filename }
  async move(destination: string) { return this.storeAs(path.dirname(destination), path.basename(destination)) }
  async store(directory: string, disk?: string) { return this.storeAs(directory, `${Date.now()}-${this.originalName()}`, disk) }
  async storeAs(directory: string, name: string, disk?: string) {
    const target = path.posix.join(directory, name)
    await Storage.disk(disk).writeStream(target, this.file.file)
    return target
  }
  async storePublicly(directory: string, disk = 'public') { return this.store(directory, disk) }
}
