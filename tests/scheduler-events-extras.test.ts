import { afterEach, describe, expect, it } from 'vitest'
import { Schedule } from '@lib/scheduler/Schedule.js'
import { Event } from '@lib/events/Event.js'

describe('Scheduler & Events Gaps', () => {
  afterEach(() => {
    Schedule.clear()
    // Clear event listeners (EventManager doesn't have a public clear() but we can re-create or clear the Map)
    ;(Event as any).listeners.clear()
  })

  describe('Scheduler Frequencies', () => {
    it('sets correct cron expressions for custom frequencies', () => {
      Schedule.call('test1', () => {}).everyFiveMinutes()
      Schedule.call('test2', () => {}).twiceDaily(3, 15)
      Schedule.call('test3', () => {}).weekdays()
      Schedule.call('test4', () => {}).weekends()
      Schedule.call('test5', () => {}).cron('1 2 3 4 5')

      const tasks = Schedule.all()
      expect(tasks.find(t => t.name === 'test1')?.expression).toBe('*/5 * * * *')
      expect(tasks.find(t => t.name === 'test2')?.expression).toBe('0 3,15 * * *')
      expect(tasks.find(t => t.name === 'test3')?.expression).toBe('0 0 * * 1-5')
      expect(tasks.find(t => t.name === 'test4')?.expression).toBe('0 0 * * 0,6')
      expect(tasks.find(t => t.name === 'test5')?.expression).toBe('1 2 3 4 5')
    })
  })

  describe('Wildcard Event Listeners', () => {
    it('dispatches to wildcard listeners matching patterns', () => {
      const logs: Array<{ name: string, payload: any }> = []

      Event.listen('order.*', (payload, name) => {
        logs.push({ name, payload })
      })

      Event.listen('*', (payload, name) => {
        logs.push({ name: `global:${name}`, payload })
      })

      Event.dispatch('order.created', { id: 1 })
      Event.dispatch('order.fulfilled', { id: 2 })
      Event.dispatch('payment.failed', { amount: 100 })

      expect(logs).toEqual([
        { name: 'order.created', payload: { id: 1 } },
        { name: 'global:order.created', payload: { id: 1 } },
        { name: 'order.fulfilled', payload: { id: 2 } },
        { name: 'global:order.fulfilled', payload: { id: 2 } },
        { name: 'global:payment.failed', payload: { amount: 100 } }
      ])
    })
  })

  describe('Event Subscribers', () => {
    it('allows registering event subscribers', () => {
      const logs: string[] = []

      class OrderEventSubscriber {
        subscribe(events: typeof Event) {
          events.listen('OrderCreated', this.onOrderCreated)
          events.listen('OrderCancelled', this.onOrderCancelled)
        }

        onOrderCreated(event: any) {
          logs.push(`created: ${event.id}`)
        }

        onOrderCancelled(event: any) {
          logs.push(`cancelled: ${event.id}`)
        }
      }

      Event.subscribe(OrderEventSubscriber)

      Event.dispatch('OrderCreated', { id: 101 })
      Event.dispatch('OrderCancelled', { id: 102 })

      expect(logs).toEqual([
        'created: 101',
        'cancelled: 102'
      ])
    })
  })
})
