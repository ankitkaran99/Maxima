import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Application, setApplication } from '@lib/index.js'
import { HttpKernel } from '@lib/http/Kernel.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const app = new Application(root)
setApplication(app)
await app.bootstrap()
await new HttpKernel(app).listen()
