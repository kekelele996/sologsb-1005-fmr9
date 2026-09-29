declare const process: any
import { WorkbenchService } from '../src/app/workbench.service'
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.has(k) ? store.get(k)! : null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear()
}
const STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
const handlers: Array<(e: StorageEvent) => void> = []
;(globalThis as any).window = {
  addEventListener: (t: string, h: any) => { if (t === 'storage') handlers.push(h) },
  removeEventListener: () => {}
}
function dispatchStorage(nv: string) { handlers.forEach(h => h({ key: STORAGE_KEY, newValue: nv } as StorageEvent)) }
function printFeatures(label: string, s: any) {
  console.log(label, 'rev:', s.revision, 'count:', s.features.length)
  for (const f of s.features) console.log('   ', f.id, 'parentId:', f.parentId, 'conflict:', f.conflict ? `${f.conflict.side}/${f.conflict.status}` : 'none')
}

const tabA = new WorkbenchService()
const tabB = new WorkbenchService()
tabA.updateFeature('feature-b', { parentId: null })
tabB.updateFeature('feature-b', { parentId: 'feature-c' })
console.log('--- after B merge ---')
printFeatures('stored:', JSON.parse(store.get(STORAGE_KEY)!))
printFeatures('B state:', tabB.snapshot)
tabA.updateFeature('feature-c', { text: 'A 对 C 的修改' })
console.log('--- after A edit ---')
printFeatures('stored:', JSON.parse(store.get(STORAGE_KEY)!))
dispatchStorage(store.get(STORAGE_KEY)!)
console.log('--- after B storage event ---')
printFeatures('stored:', JSON.parse(store.get(STORAGE_KEY)!))
printFeatures('B state:', tabB.snapshot)
