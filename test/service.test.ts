declare const process: any
import { WorkbenchService } from '../src/app/workbench.service'
import type { WorkbenchState } from '../src/app/models'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('  PASS', msg) }
  else { failures++; console.log('  FAIL', msg) }
}

// localStorage polyfill
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.has(k) ? store.get(k)! : null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear()
}

const STORAGE_KEY = 'patent-claim-mapping-workbench-v1'

function readStored(): WorkbenchState {
  return JSON.parse(store.get(STORAGE_KEY)!) as WorkbenchState
}

console.log('== 服务层：两个标签页同时编辑同一特征的层级，后保存方合并而非覆盖 ==')
{
  store.clear()
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  assert(readStored().revision === 1, '初始修订号为 1')

  // A 把 feature-b 的父级改成 feature-a（原值就是 feature-a，改成 null 制造差异）
  tabA.updateFeature('feature-b', { parentId: null })
  assert(readStored().revision === 2, 'A 保存后修订号 +1')

  // B 在各自标签页中把 feature-b 的父级改成 feature-c（与 A 不一致）
  tabB.updateFeature('feature-b', { parentId: 'feature-c' })
  const stored = readStored()
  assert(stored.revision === 3, 'B 合并后修订号 +1')
  const copies = stored.features.filter(f => f.conflict?.originalId === 'feature-b')
  assert(copies.length === 2, 'feature-b 保留两份副本')
  assert(copies.some(f => f.conflict?.side === 'local' && f.parentId === 'feature-c'), '本方副本为本方层级')
  assert(copies.some(f => f.conflict?.side === 'remote' && f.parentId === null), '对方副本为对方层级')
  assert(copies.every(f => f.conflict?.status === 'pending'), '两份均待确认')
}

console.log('== 服务层：B 随后添加批注，A 再改其他特征，双方改动都保留 ==')
{
  store.clear()
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { parentId: null })
  tabB.updateFeature('feature-b', { parentId: 'feature-c' })
  // B 添加批注
  tabB.addAnnotation('feature-b', '审查员补充：注意层级变化')
  const afterB = readStored()
  assert(afterB.annotations.some(a => a.text.includes('审查员补充')), 'B 的批注保留')
  assert(afterB.features.filter(f => f.conflict?.originalId === 'feature-b').length === 2, '冲突副本仍在')

  // A 改 feature-c 的正文（A 的基准是 rev2，落后于当前存储）
  tabA.updateFeature('feature-c', { text: 'A 对 C 的修改' })
  const afterA = readStored()
  assert(afterA.features.find(f => f.id === 'feature-c')!.text === 'A 对 C 的修改', 'A 对其他特征的修改保留')
  assert(afterA.annotations.some(a => a.text.includes('审查员补充')), 'B 的批注未被 A 的保存盖掉')
  assert(afterA.features.filter(f => f.conflict?.originalId === 'feature-b').length === 2, '冲突副本仍在')
  assert(afterA.revision === 5, '最终修订号为 5')
}

console.log('== 服务层：冲突确认保留本方 ==')
{
  store.clear()
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { parentId: null })
  tabB.updateFeature('feature-b', { parentId: 'feature-c' })
  const conflicts = tabB.snapshot.features.filter(f => f.conflict?.side === 'local')
  assert(conflicts.length === 1, 'B 有 1 个待确认冲突')
  const groupId = conflicts[0].conflict!.id
  tabB.resolveConflict(groupId, 'local')
  const after = readStored()
  assert(after.features.filter(f => f.conflict).length === 0, '冲突标记清除')
  assert(after.features.filter(f => f.id === 'feature-b').length === 1, '只保留一份 feature-b')
  assert(after.features.find(f => f.id === 'feature-b')!.parentId === 'feature-c', '保留本方层级')
}

console.log('== 服务层：冲突确认保留对方，引用与批注改指 ==')
{
  store.clear()
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { parentId: null })
  tabB.updateFeature('feature-b', { parentId: 'feature-c' })
  const conflicts = tabB.snapshot.features.filter(f => f.conflict?.side === 'local')
  const groupId = conflicts[0].conflict!.id
  tabB.resolveConflict(groupId, 'remote')
  const after = readStored()
  assert(after.features.filter(f => f.conflict).length === 0, '冲突标记清除')
  assert(after.features.filter(f => f.id === 'feature-b').length === 1, '只保留一份 feature-b')
  assert(after.features.find(f => f.id === 'feature-b')!.parentId === null, '保留对方层级')
}

console.log('== 服务层：旧数据无修订号，打开时兼容接入 ==')
{
  store.clear()
  // 写入一份没有 revision 的旧数据
  const legacy: any = {
    claims: [{ id: 'c1', number: 1, title: '旧', text: 't', independent: true }],
    paragraphs: [], features: [], annotations: [], orphanMappings: [], versions: [],
    role: 'author', currentUserRole: 'author', selectedClaimId: 'c1', selectedFeatureId: null, activeTab: 'mapping'
  }
  store.set(STORAGE_KEY, JSON.stringify(legacy))
  const tab = new WorkbenchService()
  assert(tab.snapshot.revision === 1, '旧数据兼容为修订号 1')
  assert(readStored().revision === 1, '兼容后持久化修订号')
  // 旧数据的权利要求保留
  assert(tab.snapshot.claims.some(c => c.title === '旧'), '旧数据内容保留')
}

console.log('== 服务层：只有一方编辑时不产生冲突 ==')
{
  store.clear()
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { text: 'A 改正文' })
  const stored = readStored()
  assert(stored.features.filter(f => f.conflict).length === 0, '无冲突')
  assert(stored.features.find(f => f.id === 'feature-b')!.text === 'A 改正文', 'A 的修改保留')
  // B 此时保存（B 无改动），不应盖掉 A
  tabB.selectFeature('feature-a')
  const afterB = readStored()
  assert(afterB.features.find(f => f.id === 'feature-b')!.text === 'A 改正文', 'B 的保存未盖掉 A')
}

console.log('== 服务层：撤销重做在合并后仍可用 ==')
{
  store.clear()
  const tabA = new WorkbenchService()
  const tabB = new WorkbenchService()
  tabA.updateFeature('feature-b', { parentId: null })
  tabB.updateFeature('feature-b', { parentId: 'feature-c' })
  // 合并后 B 的历史被清空（避免撤销盖掉合并结果）
  assert(!tabB.canUndo, '合并后撤销历史已清空')
  // B 再做一次编辑，应可撤销
  tabB.updateFeature('feature-c', { text: 'B 的新编辑' })
  assert(tabB.canUndo, '新编辑可撤销')
  tabB.undo()
  const afterUndo = readStored()
  assert(afterUndo.features.find(f => f.id === 'feature-c')!.text !== 'B 的新编辑', '撤销生效')
  tabB.redo()
  const afterRedo = readStored()
  assert(afterRedo.features.find(f => f.id === 'feature-c')!.text === 'B 的新编辑', '重做生效')
}

console.log('')
if (failures === 0) console.log('ALL SERVICE TESTS PASSED')
else { console.log(`${failures} SERVICE TEST(S) FAILED`); process.exit(1) }
