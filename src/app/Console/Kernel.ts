import { Schedule } from '@lib/scheduler/Schedule.js'

export function schedule() {
  Schedule.command('reports:send').hourly()
  Schedule.call('cleanup logs', async () => {}).dailyAt('02:00').withoutOverlapping()
}
