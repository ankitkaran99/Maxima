import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { User } from '@app/Models/User.js'
import { LiteTable } from '../src/LiteTable.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'

describe('LiteTable Datatables Plugin', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let app: Application
  let tempStorageRoot: string

  beforeEach(async () => {
    await DB.close()
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-litetable-'))
    process.env.MAXIMA_BASE_PATH = tempStorageRoot

    app = new Application(tempStorageRoot)
    setApplication(app)

    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
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

    // Seed mock data
    await User.create({ name: 'Alice Smith', email: 'alice@test.com', password: 'password' })
    await User.create({ name: 'Bob Jones', email: 'bob@test.com', password: 'password' })
    await User.create({ name: 'Charlie Miller', email: 'charlie@test.com', password: 'password' })
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

  it('can render basic datatable payload with pagination', async () => {
    const mockRequest: any = {
      input: (key: string, defaultValue?: any) => {
        const inputs: Record<string, any> = {
          draw: 1,
          start: 1,
          length: 2,
          columns: [
            { data: 'id', name: 'id', searchable: true, orderable: true },
            { data: 'name', name: 'name', searchable: true, orderable: true },
            { data: 'email', name: 'email', searchable: true, orderable: true }
          ]
        }
        return inputs[key] !== undefined ? inputs[key] : defaultValue
      }
    }

    const query = User.query()
    const table = LiteTable.make(query, mockRequest)
    const result = await table.render()

    expect(result.draw).toBe(1)
    expect(result.recordsTotal).toBe(3)
    expect(result.recordsFiltered).toBe(3)
    expect(result.data.length).toBe(2)
    expect(result.data[0].name).toBe('Bob Jones') // offset 1, page limit 2, so Bob and Charlie
    expect(result.data[1].name).toBe('Charlie Miller')
  })

  it('can transform columns using addColumn, editColumn, and editColumns', async () => {
    const mockRequest: any = {
      input: (key: string, defaultValue?: any) => {
        const inputs: Record<string, any> = {
          draw: 1,
          start: 0,
          length: 10,
          columns: [
            { data: 'id', name: 'id', searchable: true, orderable: true },
            { data: 'name', name: 'name', searchable: true, orderable: true }
          ]
        }
        return inputs[key] !== undefined ? inputs[key] : defaultValue
      }
    }

    const query = User.query()
    const table = LiteTable.make(query, mockRequest)
      .addIndexColumn()
      .setRowId('id')
      .addColumn('action', (row) => `<button id="btn-${row.id}">Edit</button>`)
      .editColumn('name', (row, value) => value.toUpperCase())
      .rawColumns(['action'])

    const result = await table.render()

    expect(result.data[0].DT_RowIndex).toBe(1)
    expect(result.data[0].DT_RowId).toBe('1')
    expect(result.data[0].name).toBe('ALICE SMITH')
    // action is unescaped
    expect(result.data[0].action).toBe('<button id="btn-1">Edit</button>')
  })

  it('can apply global search matching columns', async () => {
    const mockRequest: any = {
      input: (key: string, defaultValue?: any) => {
        const inputs: Record<string, any> = {
          draw: 1,
          start: 0,
          length: 10,
          search: { value: 'Smith' },
          columns: [
            { data: 'id', name: 'id', searchable: true, orderable: true },
            { data: 'name', name: 'name', searchable: true, orderable: true }
          ]
        }
        return inputs[key] !== undefined ? inputs[key] : defaultValue
      }
    }

    const query = User.query()
    const table = LiteTable.make(query, mockRequest)
    const result = await table.render()

    expect(result.recordsTotal).toBe(3)
    expect(result.recordsFiltered).toBe(1)
    expect(result.data[0].name).toBe('Alice Smith')
  })

  it('can apply column-specific search and ordering', async () => {
    const mockRequest: any = {
      input: (key: string, defaultValue?: any) => {
        const inputs: Record<string, any> = {
          draw: 1,
          start: 0,
          length: 10,
          order: [
            { column: 1, dir: 'desc' } // Order by name desc
          ],
          columns: [
            { data: 'id', name: 'id', searchable: true, orderable: true },
            { data: 'name', name: 'name', searchable: true, orderable: true, search: { value: 't' } } // filter name containing 't'
          ]
        }
        return inputs[key] !== undefined ? inputs[key] : defaultValue
      }
    }

    const query = User.query()
    const table = LiteTable.make(query, mockRequest)
    const result = await table.render()

    // Match users with 't' in name: 'Alice Smith' (contains 'Smith'), 'Bob Jones' (no 't'), 'Charlie Miller' (no 't', wait, 'Smith' contains 't')
    // Let's verify: 'Smith' has 't' (Alice Smith). Let's check if Charlie Miller has 't' - no. Bob Jones - no.
    // So only Alice Smith matches!
    expect(result.recordsFiltered).toBe(1)
    expect(result.data[0].name).toBe('Alice Smith')
  })

  it('can export datatable rows as CSV', async () => {
    const mockRequest: any = {
      input: (key: string, defaultValue?: any) => {
        const inputs: Record<string, any> = {
          columns: [
            { data: 'name', name: 'name', searchable: true, orderable: true }
          ]
        }
        return inputs[key] !== undefined ? inputs[key] : defaultValue
      }
    }

    let downloadParams: any = null
    const mockResponse: any = {
      streamDownload: (stream: Readable, name: string, headers: any) => {
        downloadParams = { name, headers, content: '' }
        return new Promise<void>((resolve, reject) => {
          stream.on('data', chunk => {
            downloadParams.content += chunk.toString()
          })
          stream.on('end', () => resolve())
          stream.on('error', err => reject(err))
        })
      }
    }

    const query = User.query()
    const table = LiteTable.make(query, mockRequest)
      .setExportHeaders(['User Name', 'Email Address'])

    await table.export(mockResponse, (row) => [row.name, row.email], 'users-export', 'csv')

    expect(downloadParams).not.toBeNull()
    expect(downloadParams.name).toBe('users-export.csv')
    expect(downloadParams.headers['content-type']).toBe('text/csv; charset=utf-8')
    // Verify UTF-8 BOM and CSV content
    expect(downloadParams.content).toContain('\uFEFFUser Name,Email Address')
    expect(downloadParams.content).toContain('Alice Smith,alice@test.com')
    expect(downloadParams.content).toContain('Bob Jones,bob@test.com')
  })
})
