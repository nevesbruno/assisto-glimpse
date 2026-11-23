import { setup } from '../../unit/contexts/orchestration/codex/codexRuntimeHarness'
import { bootAndLink, settle, type Rig, type RigWorker } from './phase2Rig'

export interface CodexWorker {
  readonly worker: RigWorker
  readonly env: ReturnType<typeof setup>
}

/** A Worker whose executor is the real Codex runtime and supervisor over a fake process and client. */
export function startCodexWorker(rig: Rig): CodexWorker {
  const env = setup()
  const worker = rig.startWorker({
    createCodexFactory: deps => ({
      probe: () => env.factory.probe(),
      start: async spec => {
        await deps.resolveExecutable()
        const runtime = await env.factory.start(spec)
        runtime.subscribe(event => env.events.push(event))
        return runtime
      },
    }),
  })
  return { worker, env }
}

export async function startLinkedCodexWorker(rig: Rig): Promise<CodexWorker> {
  const started = startCodexWorker(rig)
  await bootAndLink(started.worker)
  await settle()
  return started
}

/** The app-server of the current service exits on its own. */
export async function killService(env: CodexWorker['env'], ms = 0): Promise<void> {
  env.processes.at(-1)!.exit(1, null)
  await settle(ms)
}

type Client = ReturnType<CodexWorker['env']['client']>

const configurators = new WeakMap<
  CodexWorker['env']['clients'],
  ((client: Client, index: number) => void)[]
>()

/**
 * Runs every `configure` registered so far for each client the runtime creates from now on,
 * before it is used, in registration order: the last one wins on the same mock.
 */
export function configureNewClients(
  env: CodexWorker['env'],
  configure: (client: Client, index: number) => void,
): void {
  const known = configurators.get(env.clients)
  if (known) {
    known.push(configure)
    return
  }
  const list = [configure]
  configurators.set(env.clients, list)
  const push = env.clients.push.bind(env.clients)
  env.clients.push = (...items) => {
    items.forEach((client, offset) => list.forEach(run => run(client, env.clients.length + offset)))
    return push(...items)
  }
}
