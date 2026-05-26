import { Queue, type Job } from './Queue.js'

class BusDispatcher {
  dispatch(job: Job, queue?: string) {
    return Queue.dispatch(job, queue)
  }

  dispatchSync(job: Job, queue?: string) {
    return Queue.dispatchSync(job, queue)
  }

  dispatchAfterResponse(job: Job | (() => Promise<void> | void), queue?: string) {
    return Queue.dispatchAfterResponse(job, queue)
  }

  batch(jobs: Job[], queue?: string) {
    return Queue.batch(jobs, queue)
  }

  chain(jobs: Job[], queue?: string) {
    return Queue.chain(jobs, queue)
  }

  fake() {
    Queue.fake()
  }

  restore() {
    Queue.restore()
  }

  assertDispatched(job: string) {
    Queue.assertPushed(job)
  }
}

export const Bus = new BusDispatcher()
