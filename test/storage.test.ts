declare const process: any
import { WorkbenchService } from '../src/app/workbench.service'
import type { WorkbenchState } from '../src/app/models'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('  PASS', msg) }
  else { failures++; console.log('  FAIL', msg) }
}

const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.has(k) ? store.get(k)! : null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear()
}
const STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
function readStored(): WorkbenchState { return JSON.parse(store.get(STORAGE_KEY)!) as WorkbenchState }

// 捕获 storage 事件处理器
const handlers: Array<(e: StorageEvent) => void> = []
;(globalThis as any).window = {
  addEventListener: (type: string, handler: (e: StorageEvent) => void) => { if (type === 'storage') handlers.push(handler) },
  removeEventListener: () => {}
}

function dispatchStorage(newValue: string): void {
  const event = { key: STORAGE_KEY, newValue } as StorageEvent
  handlers.forEach(h => h(event))
}

console.log('== storage 事件：无本方改动时直接同步对方状态 ==')
{
  store.clear()
  handlers.length = 0
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { text: 'A 的实时修改' })
  assert(readStored().revision === 2, 'A 保存为 rev2')
  // 模拟 A 的保存触发 storage 事件到 B
  dispatchStorage(store.get(STORAGE_KEY)!)
  assert(tabB.snapshot.features.find(f => f.id === 'feature-b')!.text === 'A 的实时修改', 'B 实时看到 A 的修改')
  assert(readStored().revision === 2, 'B 同步未产生新写入')
}

console.log('== storage 事件：有本方改动时合并 ==')
{
  store.clear()
  handlers.length = 0
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  // A 先改层级
  tabA.updateFeature('feature-b', { parentId: null })
  // B 在收到 A 的事件前也改了层级（B 的基准是 rev1）
  tabB.updateFeature('feature-b', { parentId: 'feature-c' })
  assert(readStored().revision === 3, 'B 合并后写入 rev3')
  // 此时 A 又改了正文并保存
  tabA.updateFeature('feature-c', { text: 'A 对 C 的修改' })
  assert(readStored().revision === 4, 'A 保存为 rev4')
  // B 收到 A 的 storage 事件（rev4 > B 的 baseRev 3）
  dispatchStorage(store.get(STORAGE_KEY)!)
  const bState = tabB.snapshot
  assert(bState.features.find(f => f.id === 'feature-c')!.text === 'A 对 C 的修改', 'B 收到 A 的新修改')
  assert(bState.features.filter(f => f.conflict?.originalId === 'feature-b').length === 2, 'B 的冲突副本保留')
  assert(readStored().revision === 4, 'B 采用同步未产生新写入')
}

console.log('== storage 事件：旧修订号不触发回写 ==')
{
  store.clear()
  handlers.length = 0
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { text: 'x' })
  // B 已经同步到 rev2，再收到一个 rev2 的事件不应回写
  dispatchStorage(store.get(STORAGE_KEY)!)
  const revBefore = readStored().revision
  dispatchStorage(store.get(STORAGE_KEY)!)
  assert(readStored().revision === revBefore, '重复事件不产生新写入')
}

console.log('')
if (failures === 0) console.log('ALL STORAGE TESTS PASSED')
else { console.log(`${failures} STORAGE TEST(S) FAILED`); process.exit(1) }
