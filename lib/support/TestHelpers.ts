import { expect } from 'vitest'
import { DB } from '@lib/database/DB.js'

export async function assertDatabaseHas(table: string, criteria: Record<string, any>) {
  const record = await DB.table(table).where(criteria).first()
  expect(record).toBeDefined()
}

export async function assertDatabaseMissing(table: string, criteria: Record<string, any>) {
  const record = await DB.table(table).where(criteria).first()
  expect(record).toBeUndefined()
}

export async function assertDatabaseCount(table: string, expectedCount: number) {
  const row = await DB.table(table).count({ count: '*' }).first()
  const actualCount = Number(row?.count ?? 0)
  expect(actualCount).toBe(expectedCount)
}

export function expectResponse(response: any) {
  return {
    assertStatus(status: number) {
      expect(response.statusCode).toBe(status)
      return this
    },
    assertOk() {
      expect(response.statusCode).toBe(200)
      return this
    },
    assertJson(expected: any) {
      expect(response.json()).toEqual(expected)
      return this
    },
    assertJsonPath(path: string, expected: any) {
      const data = response.json()
      const segments = path.split('.')
      let current = data
      for (const seg of segments) {
        current = current?.[seg]
      }
      expect(current).toEqual(expected)
      return this
    },
    assertRedirect(expectedUrl?: string) {
      expect([301, 302, 303, 307, 308]).toContain(response.statusCode)
      if (expectedUrl) {
        expect(response.headers.location).toBe(expectedUrl)
      }
      return this
    },
    assertHeader(name: string, value: string) {
      expect(response.headers[name.toLowerCase()]).toBe(value)
      return this
    }
  }
}
