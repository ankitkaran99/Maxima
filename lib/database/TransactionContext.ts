import { AsyncLocalStorage } from 'node:async_hooks'

export interface TransactionState {
  depth: number
  deferredEvents: Array<() => any | Promise<any>>
  afterCommitCallbacks: Array<() => void | Promise<void>>
}

export const transactionStorage = new AsyncLocalStorage<TransactionState>()
