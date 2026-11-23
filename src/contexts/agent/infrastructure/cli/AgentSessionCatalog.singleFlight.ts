// 会话列表扫描的合并与短缓存。
//
// 背景:渲染层会在界面刷新时重复请求会话列表。若上一次扫描尚未结束就又发起一次,
// 两次扫描会同时打开同一批 transcript 文件,句柄数量随「重叠扫描数 × 文件数」增长
// (实测曾累积到 45k fd / 4GB RSS)。
//
// 策略:
//   - 同一 key 的并发调用共享同一个 Promise(single-flight),只真正扫描一次;
//   - 扫描完成后结果在内存里保留一个很短的 TTL,吸收紧随其后的重复请求;
//   - 失败不缓存,下一次调用重新尝试。

const IN_FLIGHT = new Map<string, Promise<unknown>>()
const COMPLETED = new Map<string, { expiresAt: number; value: unknown }>()

const COMPLETED_TTL_MS = 1_000
const MAX_COMPLETED_ENTRIES = 128

export function runSingleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const completed = COMPLETED.get(key)
  if (completed && completed.expiresAt > Date.now()) {
    return Promise.resolve(completed.value as T)
  }

  const inFlight = IN_FLIGHT.get(key)
  if (inFlight) {
    return inFlight as Promise<T>
  }

  const promise = run()
    .then(value => {
      COMPLETED.set(key, { expiresAt: Date.now() + COMPLETED_TTL_MS, value })

      while (COMPLETED.size > MAX_COMPLETED_ENTRIES) {
        const oldestKey = COMPLETED.keys().next().value
        if (oldestKey === undefined) {
          break
        }

        COMPLETED.delete(oldestKey)
      }

      return value
    })
    .finally(() => {
      IN_FLIGHT.delete(key)
    })

  IN_FLIGHT.set(key, promise)
  return promise
}

/** 清空合并状态与短缓存。仅供测试隔离用例。 */
export function clearAgentSessionCatalogCache(): void {
  IN_FLIGHT.clear()
  COMPLETED.clear()
}
