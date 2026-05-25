declare module 'bee-queue' {
  export default class BeeQueue {
    constructor(name: string, options?: any)
    createJob(data: any): {
      retries(count: number): any
      delayUntil(timestamp: number): any
      save(): Promise<any>
    }
    process(handler: (job: any) => Promise<void>): void
  }
}
