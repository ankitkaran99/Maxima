import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB } from '@lib/database/DB.js'
import { assertDatabaseHas, assertDatabaseMissing, assertDatabaseCount, expectResponse } from '@lib/support/TestHelpers.js'

import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'

describe('Testing DX Gaps', () => {
  let app: Application

  beforeEach(async () => {
    app = new Application(process.cwd())
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    await DB.connection().schema.createTable('dx_test_table', table => {
      table.increments('id')
      table.string('name')
    })
  })

  afterEach(async () => {
    await DB.connection().schema.dropTableIfExists('dx_test_table')
    await DB.close()
  })

  it('runs database assertions successfully', async () => {
    await DB.table('dx_test_table').insert({ name: 'Maxima' })

    await assertDatabaseHas('dx_test_table', { name: 'Maxima' })
    await assertDatabaseMissing('dx_test_table', { name: 'Unknown' })
    await assertDatabaseCount('dx_test_table', 1)
  })

  it('runs HTTP response assertions successfully', () => {
    const mockResponse = {
      statusCode: 200,
      headers: {
        location: '/redirect-here',
        'content-type': 'application/json'
      },
      json() {
        return {
          user: {
            id: 42,
            name: 'Bob'
          }
        }
      }
    }

    expectResponse(mockResponse)
      .assertStatus(200)
      .assertOk()
      .assertJson({ user: { id: 42, name: 'Bob' } })
      .assertJsonPath('user.name', 'Bob')
      .assertHeader('Content-Type', 'application/json')

    const redirectResponse = {
      statusCode: 302,
      headers: {
        location: '/dashboard'
      }
    }

    expectResponse(redirectResponse).assertRedirect('/dashboard')
  })
})
