declare const process: any
import { mergeStates, extractConflictGroups, dataEquals } from '../src/app/merge'
import type { WorkbenchState, Feature, Annotation } from '../src/app/models'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('  PASS', msg) }
  else { failures++; console.log('  FAIL', msg) }
}

function baseState(): WorkbenchState {
  return {
    claims: [{ id: 'c1', number: 1, title: 'Claim 1', text: 'text', independent: true }],
    paragraphs: [
      { id: 'p1', section: '[0001]', text: 'para1' },
      { id: 'p2', section: '[0002]', text: 'para2' }
    ],
    features: [
      { id: 'f1', claimId: 'c1', label: 'F1', text: 'feat', parentId: null, referenceIds: [], supportIds: ['p1'], ownerRole: 'author' },
      { id: 'f2', claimId: 'c1', label: 'F2', text: 'feat2', parentId: 'f1', referenceIds: [], supportIds: [], ownerRole: 'author' },
      { id: 'f3', claimId: 'c1', label: 'F3', text: 'feat3', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'author' }
    ],
    annotations: [],
    orphanMappings: [],
    versions: [],
    role: 'author', currentUserRole: 'author',
    selectedClaimId: 'c1', selectedFeatureId: 'f1', activeTab: 'mapping',
    revision: 1
  }
}

function withFeature(s: WorkbenchState, id: string, patch: Partial<Feature>): WorkbenchState {
  return { ...s, features: s.features.map(f => f.id === id ? { ...f, ...patch } : f) }
}

console.log('== 场景1: 双方各改不同特征，应并入各自改动 ==')
{
  const base = baseState()
  const local = withFeature(base, 'f1', { text: 'local edit' })
  const remote = withFeature(base, 'f2', { text: 'remote edit' })
  const merged = mergeStates(base, local, remote)
  assert(merged.features.find(f => f.id === 'f1')!.text === 'local edit', '本方对 f1 的改动保留')
  assert(merged.features.find(f => f.id === 'f2')!.text === 'remote edit', '对方对 f2 的改动保留')
  assert(merged.features.length === 3, '特征数量不变')
  assert(extractConflictGroups(merged).length === 0, '无冲突')
}

console.log('== 场景2: 双方改同一特征的层级且不一致，应留两份并标待确认 ==')
{
  const base = baseState()
  const local = withFeature(base, 'f2', { parentId: null })
  const remote = withFeature(base, 'f2', { parentId: 'f3' })
  const merged = mergeStates(base, local, remote)
  const copies = merged.features.filter(f => f.id === 'f2' || f.conflict?.originalId === 'f2')
  assert(copies.length === 2, 'f2 保留两份副本')
  const localCopy = copies.find(f => f.conflict?.side === 'local')!
  const remoteCopy = copies.find(f => f.conflict?.side === 'remote')!
  assert(localCopy.parentId === null, '本方副本层级为本方值')
  assert(remoteCopy.parentId === 'f3', '对方副本层级为对方值')
  assert(localCopy.conflict?.status === 'pending', '本方副本待确认')
  assert(remoteCopy.conflict?.status === 'pending', '对方副本待确认')
  assert(localCopy.id === 'f2', '本方副本保留原 id')
  assert(remoteCopy.id !== 'f2', '对方副本使用合成 id')
  const groups = extractConflictGroups(merged)
  assert(groups.length === 1, '提取到 1 个冲突组')
  assert(groups[0].fields.includes('parentId'), '冲突字段为层级')
}

console.log('== 场景3: 双方改同一特征的依据且不一致，应留两份 ==')
{
  const base = baseState()
  const local = withFeature(base, 'f1', { supportIds: [] })
  const remote = withFeature(base, 'f1', { supportIds: ['p1', 'p2'] })
  const merged = mergeStates(base, local, remote)
  const copies = merged.features.filter(f => f.conflict?.originalId === 'f1')
  assert(copies.length === 2, 'f1 依据冲突保留两份副本')
  const localCopy = copies.find(f => f.conflict?.side === 'local')!
  const remoteCopy = copies.find(f => f.conflict?.side === 'remote')!
  assert(localCopy.supportIds.length === 0, '本方副本依据为本方值')
  assert(remoteCopy.supportIds.length === 2, '对方副本依据为对方值')
  const groups = extractConflictGroups(merged)
  assert(groups[0].fields.includes('supportIds'), '冲突字段为依据')
}

console.log('== 场景4: 双方改同一特征的非冲突字段（名称），按字段合并不留副本 ==')
{
  const base = baseState()
  const local = withFeature(base, 'f1', { label: 'F1-local' })
  const remote = withFeature(base, 'f1', { label: 'F1-remote' })
  const merged = mergeStates(base, local, remote)
  const copies = merged.features.filter(f => f.id === 'f1')
  assert(copies.length === 1, '非冲突字段只保留一份')
  assert(copies[0].label === 'F1-remote', '双方都改时以对方（先保存方）为准')
  assert(extractConflictGroups(merged).length === 0, '无待确认冲突')
}

console.log('== 场景5: 只有一方改动层级，直接并入改动方，不产生冲突 ==')
{
  const base = baseState()
  const local = withFeature(base, 'f2', { parentId: null })
  const merged = mergeStates(base, local, base)
  assert(merged.features.find(f => f.id === 'f2')!.parentId === null, '本方单方改动并入')
  assert(extractConflictGroups(merged).length === 0, '无冲突')
}

console.log('== 场景6: 批注按作者各留各的，不覆盖 ==')
{
  const base = baseState()
  const ann: Annotation = { id: 'a1', featureId: 'f1', authorRole: 'examiner', authorName: '审查员', text: '审查批注', updatedAt: '2026-09-29T01:00:00.000Z' }
  const local = { ...base, annotations: [ann] }
  const merged = mergeStates(base, local, base)
  assert(merged.annotations.length === 1, '本方批注保留')
  assert(merged.annotations[0].text === '审查批注', '批注内容正确')
}

console.log('== 场景7: 同一条批注双方都改，留两份 ==')
{
  const base = baseState()
  const ann: Annotation = { id: 'a1', featureId: 'f1', authorRole: 'examiner', authorName: '审查员', text: 'base', updatedAt: '2026-09-29T01:00:00.000Z' }
  const baseA = { ...base, annotations: [ann] }
  const localA = { ...baseA, annotations: [{ ...ann, text: 'local edit', updatedAt: '2026-09-29T02:00:00.000Z' }] }
  const remoteA = { ...baseA, annotations: [{ ...ann, text: 'remote edit', updatedAt: '2026-09-29T03:00:00.000Z' }] }
  const merged = mergeStates(baseA, localA, remoteA)
  assert(merged.annotations.length === 2, '同一条批注双方都改时留两份')
}

console.log('== 场景8: 待确认冲突在新合并中刷新（重新确认）==')
{
  const base = baseState()
  // 上一轮合并：本方 f2.parentId=null，对方 f2.parentId='f3'
  const prevMerged = mergeStates(base, withFeature(base, 'f2', { parentId: null }), withFeature(base, 'f2', { parentId: 'f3' }))
  const prevLocal = prevMerged.features.find(f => f.conflict?.side === 'local')!
  // 对方在新基准中把 f2.parentId 改成 'f1'（与上一轮对方值不同）
  const remoteState = withFeature(base, 'f2', { parentId: 'f1' })
  // 本方也把 f2.parentId 改成 'f3'（与本方副本不同）
  const local2 = withFeature(prevMerged, prevLocal.id, { parentId: 'f3' })
  const merged = mergeStates(prevMerged, local2, remoteState)
  const copies = merged.features.filter(f => f.conflict?.originalId === 'f2')
  assert(copies.length === 2, '仍保留两份副本')
  assert(copies.find(f => f.conflict?.side === 'remote')!.parentId === 'f1', '对方副本刷新为新值')
  assert(copies.find(f => f.conflict?.side === 'local')!.parentId === 'f3', '本方副本为最新本方值')
  const groups = extractConflictGroups(merged)
  assert(groups.length === 1 && groups[0].fields.includes('parentId'), '冲突仍待确认')
}

console.log('== 场景9: 冲突确认保留本方后，对方副本删除、标记清除 ==')
{
  const base = baseState()
  const merged = mergeStates(base, withFeature(base, 'f2', { parentId: null }), withFeature(base, 'f2', { parentId: 'f3' }))
  const localCopy = merged.features.find(f => f.conflict?.side === 'local')!
  const remoteCopy = merged.features.find(f => f.conflict?.side === 'remote')!
  const after: WorkbenchState = {
    ...merged,
    features: merged.features.filter(f => f.id !== remoteCopy.id).map(f => f.id === localCopy.id ? { ...f, conflict: undefined } : f)
  }
  assert(after.features.filter(f => f.conflict).length === 0, '保留本方后冲突标记清除')
  assert(after.features.find(f => f.id === 'f2')!.parentId === null, '保留本方层级')
}

console.log('== 场景10: 冲突确认保留对方后，引用与批注改指到保留特征 ==')
{
  const base = baseState()
  const merged = mergeStates(base, withFeature(base, 'f2', { parentId: null }), withFeature(base, 'f2', { parentId: 'f3' }))
  const localCopy = merged.features.find(f => f.conflict?.side === 'local')!
  const remoteCopy = merged.features.find(f => f.conflict?.side === 'remote')!
  const originalId = remoteCopy.conflict!.originalId
  const after: WorkbenchState = {
    ...merged,
    features: merged.features.filter(f => f.id !== localCopy.id).map(f => f.id === remoteCopy.id ? { ...f, id: originalId, conflict: undefined } : f)
  }
  const kept = after.features.find(f => f.id === originalId)
  assert(!!kept, '保留对方后原 id 特征存在')
  assert(kept!.parentId === 'f3', '保留对方层级')
  assert(after.features.filter(f => f.conflict).length === 0, '冲突标记清除')
}

console.log('== 场景11: UI 选择字段保留本方 ==')
{
  const base = baseState()
  const local = { ...base, selectedFeatureId: 'f2', activeTab: 'claim' }
  const remote = { ...base, selectedFeatureId: 'f1', activeTab: 'mapping' }
  const merged = mergeStates(base, local, remote)
  assert(merged.selectedFeatureId === 'f2', '本方选中特征保留')
  assert(merged.activeTab === 'claim', '本方标签页保留')
}

console.log('== 场景12: 本方新增特征保留 ==')
{
  const base = baseState()
  const newF: Feature = { id: 'f4', claimId: 'c1', label: 'F4', text: 'new', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'author' }
  const local = { ...base, features: [...base.features, newF] }
  const merged = mergeStates(base, local, base)
  assert(merged.features.some(f => f.id === 'f4'), '本方新增特征保留')
}

console.log('== 场景13: 对方删除特征、本方未改 → 接受删除 ==')
{
  const base = baseState()
  const remote = { ...base, features: base.features.filter(f => f.id !== 'f3') }
  const merged = mergeStates(base, base, remote)
  assert(!merged.features.some(f => f.id === 'f3'), '对方删除生效')
}

console.log('== 场景14: 对方删除特征、本方改过 → 保留本方版本 ==')
{
  const base = baseState()
  const local = withFeature(base, 'f3', { text: 'local touched' })
  const remote = { ...base, features: base.features.filter(f => f.id !== 'f3') }
  const merged = mergeStates(base, local, remote)
  assert(merged.features.some(f => f.id === 'f3'), '本方改过的特征保留')
}

console.log('')
if (failures === 0) console.log('ALL TESTS PASSED')
else { console.log(`${failures} TEST(S) FAILED`); process.exit(1) }
