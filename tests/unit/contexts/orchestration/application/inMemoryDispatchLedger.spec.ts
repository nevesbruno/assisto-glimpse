import { InMemoryDispatchLedger } from './inMemoryDispatchLedger'
import { InMemoryDispatches, InMemoryLinks, InMemoryNotices } from './fakes'
import { describeDispatchLedgerContract } from './dispatchLedgerContract'

describeDispatchLedgerContract('in memory', () => {
  const links = new InMemoryLinks()
  const dispatches = new InMemoryDispatches()
  const notices = new InMemoryNotices()
  const ledger = new InMemoryDispatchLedger(links, dispatches, notices)
  return {
    ledger,
    links,
    dispatches,
    notices,
    injectFailure: point => {
      ledger.failAt = point
    },
  }
})
