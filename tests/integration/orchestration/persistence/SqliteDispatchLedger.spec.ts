// @vitest-environment node
import { describeDispatchLedgerContract } from '../../../unit/contexts/orchestration/application/dispatchLedgerContract'
import { SqliteAgentLinkRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteAgentLinkRepository'
import { SqliteDispatchLedger } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteDispatchLedger'
import { SqliteDispatchRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteDispatchRepository'
import { SqliteNoticeOutboxRepository } from '../../../../src/contexts/orchestration/infrastructure/persistence/SqliteNoticeOutboxRepository'
import { createTempDatabase } from './orchestrationDb'

const FAILURE_TABLE = {
  accept: 'orchestration_dispatches',
  settle: 'orchestration_notices',
} as const

describeDispatchLedgerContract('SQLite', () => {
  const database = createTempDatabase()
  const db = database.open()
  return {
    ledger: new SqliteDispatchLedger(db),
    links: new SqliteAgentLinkRepository(db),
    dispatches: new SqliteDispatchRepository(db),
    notices: new SqliteNoticeOutboxRepository(db),
    injectFailure: point =>
      db.exec(
        `CREATE TRIGGER injected_failure BEFORE INSERT ON ${FAILURE_TABLE[point]}
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
      ),
    dispose: () => database.dispose(),
  }
})
