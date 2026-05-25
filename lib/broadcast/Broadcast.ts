type BroadcastPayload = {
  name: string
  channels: string[] | string
  payload: Record<string, any>
}

export interface BroadcastableEvent {
  broadcastOn(): string[] | string
  broadcastAs?(): string
  broadcastWith?(): Record<string, any>
}

export class BroadcastManager {
  private fakePayloads: BroadcastPayload[] | null = null
  private channels = new Map<string, (user: any, ...args: any[]) => boolean | Promise<boolean>>()
  private broadcastCallbacks = new Set<(event: BroadcastPayload) => void>()
  private presenceMembers = new Map<string, Map<string, any>>()

  fake() {
    this.fakePayloads = []
  }

  restore() {
    this.fakePayloads = null
  }

  broadcasted() {
    return this.fakePayloads ?? []
  }

  channel(namePattern: string, callback: (user: any, ...args: any[]) => boolean | Promise<boolean>) {
    this.channels.set(namePattern, callback)
    return this
  }

  async authorize(user: any, channelName: string): Promise<boolean> {
    for (const [pattern, callback] of this.channels.entries()) {
      const regexPattern = '^' + pattern
        .replace(/\{[A-Za-z0-9_]+\}/g, '([^.]+)')
        .replace(/:[A-Za-z0-9_]+/g, '([^.]+)')
        .replace(/\./g, '\\.') + '$'
      const regex = new RegExp(regexPattern)
      const match = channelName.match(regex)
      if (match) {
        const args = match.slice(1).map(val => isNaN(Number(val)) ? val : Number(val))
        try {
          return Boolean(await Promise.resolve(callback(user, ...args)))
        } catch {
          return false
        }
      }
    }
    if (!channelName.startsWith('private-') && !channelName.startsWith('presence-')) {
      return true
    }
    return false
  }

  joinPresence(channel: string, user: any) {
    const id = String(user?.id ?? user?.uuid ?? user?.email ?? JSON.stringify(user))
    if (!id || id === 'undefined') return []
    const members = this.presenceMembers.get(channel) ?? new Map<string, any>()
    members.set(id, user)
    this.presenceMembers.set(channel, members)
    return [...members.values()]
  }

  leavePresence(channel: string, user: any) {
    const id = String(user?.id ?? user?.uuid ?? user?.email ?? JSON.stringify(user))
    const members = this.presenceMembers.get(channel)
    if (!members) return []
    members.delete(id)
    if (!members.size) this.presenceMembers.delete(channel)
    return [...members.values()]
  }

  members(channel: string) {
    return [...(this.presenceMembers.get(channel)?.values() ?? [])]
  }

  onBroadcast(callback: (event: BroadcastPayload) => void) {
    this.broadcastCallbacks.add(callback)
    return () => this.broadcastCallbacks.delete(callback)
  }

  async broadcast(event: BroadcastableEvent) {
    const payload: BroadcastPayload = {
      name: event.broadcastAs?.() ?? event.constructor.name,
      channels: event.broadcastOn(),
      payload: event.broadcastWith?.() ?? {}
    }

    if (this.fakePayloads) {
      this.fakePayloads.push(payload)
      return payload
    }

    for (const cb of this.broadcastCallbacks) {
      try {
        cb(payload)
      } catch {}
    }

    return payload
  }

  assertBroadcasted(name: string) {
    if (!this.fakePayloads?.some(payload => payload.name === name)) {
      throw new Error(`Expected broadcast [${name}] was not dispatched.`)
    }
  }

  assertNothingBroadcasted() {
    if (this.fakePayloads?.length) throw new Error('Expected no broadcasts to be dispatched.')
  }
}

export const Broadcast = new BroadcastManager()
