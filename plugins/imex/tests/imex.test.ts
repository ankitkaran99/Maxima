import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { User } from '@app/Models/User.js'
import { ImEx } from '../src/ImEx.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import * as XLSX from 'xlsx'

describe('ImEx Import Export Plugin', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let app: Application
  let tempStorageRoot: string

  beforeEach(async () => {
    await DB.close()
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-imex-'))
    process.env.MAXIMA_BASE_PATH = tempStorageRoot

    app = new Application(tempStorageRoot)
    setApplication(app)

    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    // Setup users table
    await DB.connection().schema.createTable('users', table => {
      table.increments('id').primary()
      table.string('name')
      table.string('email').unique()
      table.string('password')
      table.timestamps(true, true)
    })

    // Configure storage
    app.config.set('filesystems.default', 'local')
    app.config.set('filesystems.disks.local', {
      driver: 'local',
      root: path.join(tempStorageRoot, 'storage')
    })
  })

  afterEach(async () => {
    await DB.close()
    if (originalBasePath) {
      process.env.MAXIMA_BASE_PATH = originalBasePath
    } else {
      delete process.env.MAXIMA_BASE_PATH
    }
    await fs.rm(tempStorageRoot, { recursive: true, force: true })
  })

  it('can download an export array as CSV', async () => {
    class MockExport {
      headings() {
        return ['Title', 'Author']
      }
      map(row: any) {
        return [row.title.toUpperCase(), row.author]
      }
      array() {
        return [
          { title: 'The Hobbit', author: 'Tolkien' },
          { title: 'Dune', author: 'Herbert' }
        ]
      }
    }

    let downloadParams: any = null
    const mockResponse: any = {
      streamDownload: (stream: Readable, name: string, headers: any) => {
        downloadParams = { name, headers, content: Buffer.alloc(0) }
        return new Promise<void>((resolve, reject) => {
          stream.on('data', chunk => {
            downloadParams.content = Buffer.concat([downloadParams.content, chunk])
          })
          stream.on('end', () => resolve())
          stream.on('error', err => reject(err))
        })
      }
    }

    await ImEx.download(mockResponse, new MockExport(), 'books-export.csv')

    expect(downloadParams).not.toBeNull()
    expect(downloadParams.name).toBe('books-export.csv')
    expect(downloadParams.headers['content-type']).toBe('text/csv; charset=utf-8')
    
    // Parse the returned CSV buffer to verify
    const parsedWorkbook = XLSX.read(downloadParams.content, { type: 'buffer' })
    const rows: any[][] = XLSX.utils.sheet_to_json(parsedWorkbook.Sheets.Sheet1, { header: 1 })
    expect(rows[0]).toEqual(['Title', 'Author'])
    expect(rows[1]).toEqual(['THE HOBBIT', 'Tolkien'])
    expect(rows[2]).toEqual(['DUNE', 'Herbert'])
  })

  it('can store a DB query export as XLSX in storage', async () => {
    // Seed DB users
    await User.create({ name: 'Alice Smith', email: 'alice@test.com', password: 'password' })
    await User.create({ name: 'Bob Jones', email: 'bob@test.com', password: 'password' })

    class UsersExport {
      headings() {
        return ['ID', 'User Name']
      }
      map(user: any) {
        return [user.id, user.name]
      }
      query() {
        return User.query() // returns ModelQueryBuilder
      }
    }

    await ImEx.store(new UsersExport(), 'exports/users.xlsx')

    // Read file from storage to verify it was written
    const { Storage } = await import('@lib/storage/Storage.js')
    const storedBuffer = await Storage.disk().get('exports/users.xlsx')
    expect(storedBuffer).toBeDefined()

    const parsedWorkbook = XLSX.read(storedBuffer, { type: 'buffer' })
    const rows: any[][] = XLSX.utils.sheet_to_json(parsedWorkbook.Sheets.Sheet1, { header: 1 })
    expect(rows[0]).toEqual(['ID', 'User Name'])
    expect(rows[1]).toEqual([1, 'Alice Smith'])
    expect(rows[2]).toEqual([2, 'Bob Jones'])
  })

  it('can import users from excel buffer mapped to Model', async () => {
    // Create an excel buffer
    const mockData = [
      ['Full Name', 'Email Address'],
      ['Charlie Miller', 'charlie@import.com'],
      ['Dave Wilson', 'dave@import.com']
    ]
    const worksheet = XLSX.utils.aoa_to_sheet(mockData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
    const fileBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })

    // Create import target
    class UsersImport {
      headingRow() {
        return 1
      }
      model(row: any) {
        return new User({
          name: row['Full Name'],
          email: row['Email Address'],
          password: 'password'
        })
      }
    }

    await ImEx.import(new UsersImport(), fileBuffer)

    // Verify DB
    const users = await User.query().orderBy('id', 'asc').get()
    expect(users.length).toBe(2)
    expect(users[0].name).toBe('Charlie Miller')
    expect(users[0].email).toBe('charlie@import.com')
    expect(users[1].name).toBe('Dave Wilson')
    expect(users[1].email).toBe('dave@import.com')
  })

  it('can import users to Collection callback', async () => {
    // Create an excel buffer (raw values, no heading mapping)
    const mockData = [
      ['Eve Adams', 'eve@import.com'],
      ['Frank Miller', 'frank@import.com']
    ]
    const worksheet = XLSX.utils.aoa_to_sheet(mockData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
    const fileBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })

    const importedItems: any[] = []
    class CustomCollectionImport {
      collection(rows: any[]) {
        importedItems.push(...rows)
      }
    }

    await ImEx.import(new CustomCollectionImport(), fileBuffer)

    expect(importedItems.length).toBe(2)
    expect(importedItems[0]).toEqual(['Eve Adams', 'eve@import.com'])
    expect(importedItems[1]).toEqual(['Frank Miller', 'frank@import.com'])
  })
})
