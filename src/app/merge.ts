import type { Annotation, Claim, ConflictField, Feature, Paragraph, WorkbenchState } from './models'

/** 冲突组：同一特征的本方副本与对方副本，待用户确认保留哪一份 */
export interface ConflictGroup {
  id: string
  originalId: string
  fields: ConflictField[]
  localFeature: Feature
  remoteFeature: Feature
}

export function clone<T>(value: T): T { return structuredClone(value) }

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a), sb = new Set(b)
  for (const id of sa) if (!sb.has(id)) return false
  return true
}

/** 字段级合并：只并入本方或对方各自改动过的字段；两边都改时以对方（先保存方）为准 */
function mergeField<T>(base: T, local: T, remote: T): T {
  const localChanged = !deepEqual(local, base)
  const remoteChanged = !deepEqual(remote, base)
  if (localChanged && remoteChanged) return clone(remote)
  if (localChanged) return clone(local)
  if (remoteChanged) return clone(remote)
  return clone(base)
}

function mergeScalarRecord<T extends { id: string }>(
  base: T | undefined, local: T | undefined, remote: T | undefined,
  keys: Array<keyof T>
): T | undefined {
  if (!base) return remote ? clone(remote) : local ? clone(local) : undefined
  if (!local) return remote ? clone(remote) : undefined
  if (!remote) return clone(local)
  const out: Record<string, unknown> = { ...clone(base) }
  for (const key of keys) {
    out[key as string] = mergeField(base[key], local[key], remote[key])
  }
  return out as T
}

const CLAIM_KEYS: Array<keyof Claim> = ['number', 'title', 'text', 'independent']
const PARAGRAPH_KEYS: Array<keyof Paragraph> = ['section', 'text']
const FEATURE_KEYS: Array<keyof Feature> = ['claimId', 'label', 'text', 'parentId', 'referenceIds', 'supportIds', 'ownerRole']

function mergeClaim(base: Claim | undefined, local: Claim | undefined, remote: Claim | undefined): Claim | undefined {
  return mergeScalarRecord(base, local, remote, CLAIM_KEYS)
}

function mergeParagraph(base: Paragraph | undefined, local: Paragraph | undefined, remote: Paragraph | undefined): Paragraph | undefined {
  return mergeScalarRecord(base, local, remote, PARAGRAPH_KEYS)
}

/** 非冲突字段的标量合并（层级/依据字段在冲突副本中各自保留本方值），并清除可能残留的冲突标记 */
function mergeScalarFeature(base: Feature, local: Feature, remote: Feature): Feature {
  const out = mergeScalarRecord(base, local, remote, FEATURE_KEYS) as Feature
  delete out.conflict
  return out
}

function conflictFields(base: Feature, local: Feature, remote: Feature): ConflictField[] {
  const fields: ConflictField[] = []
  const parentChanged = (a: Feature, b: Feature) => a.parentId !== b.parentId
  if (parentChanged(base, local) && parentChanged(base, remote) && parentChanged(local, remote)) {
    fields.push('parentId')
  }
  const supportChanged = (a: Feature, b: Feature) => !setsEqual(a.supportIds, b.supportIds)
  if (supportChanged(base, local) && supportChanged(base, remote) && supportChanged(local, remote)) {
    fields.push('supportIds')
  }
  return fields
}

/**
 * 特征合并。
 * - 只有一方改动：并入改动方的特征；
 * - 双方都改动且仅涉及层级/依据以外的字段：按字段级合并；
 * - 双方都改动且层级或依据不一致：保留两份副本（本方 id 不变、对方使用合成 id），
 *   标记为待确认；若上一轮合并已存在待确认副本，则刷新对方副本的值（重新确认）。
 * - 对方状态中已有的 remote-side 副本属于历史合并产物，原样保留。
 */
function mergeFeatures(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): Feature[] {
  const result: Feature[] = []
  const handledOriginalIds = new Set<string>()

  // 1. 合并“活跃特征”（无冲突标记，或 local-side 副本）；remote-side 副本在第 3 步单独处理
  for (const r of remote.features) {
    if (r.conflict?.side === 'remote') continue
    const b = base.features.find(item => item.id === r.id)
    const l = local.features.find(item => item.id === r.id && item.conflict?.side !== 'remote')

    if (!b) {
      result.push(clone(r))
      handledOriginalIds.add(r.id)
      continue
    }
    if (!l) {
      // 本方删除了该特征
      if (!deepEqual(b, r)) result.push(clone(r)) // 对方也改过：保留对方版本，避免丢掉对方改动
      handledOriginalIds.add(r.id)
      continue
    }

    const localChanged = !deepEqual(b, l)
    const remoteChanged = !deepEqual(b, r)
    if (!localChanged && !remoteChanged) { result.push(clone(b)); handledOriginalIds.add(r.id); continue }
    if (!localChanged) { result.push(clone(r)); handledOriginalIds.add(r.id); continue }
    if (!remoteChanged) { result.push(clone(l)); handledOriginalIds.add(r.id); continue }

    const fields = conflictFields(b, l, r)
    if (fields.length === 0) {
      result.push(mergeScalarFeature(b, l, r))
      handledOriginalIds.add(r.id)
      continue
    }

    // 双方对层级/依据的修改不一致：保留两份，标为待确认
    const existingRemote = local.features.find(item => item.conflict?.originalId === r.id && item.conflict.side === 'remote')
    const groupId = l.conflict?.id || existingRemote?.conflict?.id || `conflict-${Date.now()}-${r.id}`
    const scalar = mergeScalarFeature(b, l, r)
    const localCopy: Feature = {
      ...scalar,
      id: r.id,
      parentId: fields.includes('parentId') ? l.parentId : scalar.parentId,
      supportIds: fields.includes('supportIds') ? [...l.supportIds] : [...scalar.supportIds],
      conflict: { id: groupId, side: 'local', originalId: r.id, fields, status: 'pending' }
    }
    const remoteCopy: Feature = {
      ...clone(r),
      id: existingRemote?.id || `${r.id}__conflict__${groupId}`,
      conflict: { id: groupId, side: 'remote', originalId: r.id, fields, status: 'pending' }
    }
    result.push(localCopy, remoteCopy)
    handledOriginalIds.add(r.id)
  }

  // 2. 本方新增 / 对方删除后本方仍保留的活跃特征
  for (const l of local.features) {
    if (l.conflict?.side === 'remote') continue
    if (handledOriginalIds.has(l.id)) continue
    const b = base.features.find(item => item.id === l.id)
    const r = remote.features.find(item => item.id === l.id)
    if (!b && !r) { result.push(clone(l)); continue } // 本方新增
    if (b && !r) {
      if (deepEqual(b, l)) continue // 本方未改：接受对方删除
      result.push(clone(l))         // 本方改过：保留本方版本
    }
  }

  // 3. 沿用历史合并产物（remote-side 副本）：优先保留对方状态中的版本，其次本方的；
  //    若对方状态中仍有该 originalId 的活跃特征，第 1 步已处理（可能已生成新的 remoteCopy），不再重复
  const remoteArtifacts = remote.features.filter(item => item.conflict?.side === 'remote')
  const localArtifacts = local.features.filter(item => item.conflict?.side === 'remote')
  for (const artifact of remoteArtifacts) result.push(clone(artifact))
  for (const artifact of localArtifacts) {
    const originalId = artifact.conflict!.originalId
    if (remoteArtifacts.some(item => item.conflict!.originalId === originalId)) continue
    if (remote.features.some(item => item.id === originalId && item.conflict?.side !== 'remote')) continue
    result.push(clone(artifact))
  }

  return result
}

/**
 * 批注合并：按 id 取并集；同一条批注双方都改过时，按更新时间取较新者，
 * 并把较旧的本方版本复制留存（批注按作者各留各的，不覆盖他人批注）。
 */
function mergeAnnotations(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): Annotation[] {
  const map = new Map<string, Annotation>()
  for (const a of remote.annotations) map.set(a.id, clone(a))
  for (const a of local.annotations) {
    const r = map.get(a.id)
    if (!r) { map.set(a.id, clone(a)); continue }
    if (a.text === r.text && a.updatedAt === r.updatedAt) continue
    const b = base.annotations.find(item => item.id === a.id)
    const localChanged = b ? !deepEqual(b, a) : true
    const remoteChanged = b ? !deepEqual(b, r) : true
    if (localChanged && !remoteChanged) { map.set(a.id, clone(a)); continue }
    if (!localChanged && remoteChanged) { map.set(a.id, clone(r)); continue }
    // 双方都改了同一条：留两份，避免任何一方的批注丢失
    const localIsNewer = a.updatedAt >= r.updatedAt
    const winner = localIsNewer ? a : r
    const loser = localIsNewer ? r : a
    map.set(winner.id, clone(winner))
    map.set(`${loser.id}__dup__${Date.now()}`, { ...clone(loser), id: `${loser.id}__dup__${Date.now()}` })
  }
  return Array.from(map.values())
}

function mergeById<T extends { id: string }>(
  base: T[], local: T[], remote: T[],
  mergeItem: (base: T | undefined, local: T | undefined, remote: T | undefined) => T | undefined
): T[] {
  const ids = new Set<string>()
  base.forEach(item => ids.add(item.id))
  local.forEach(item => ids.add(item.id))
  remote.forEach(item => ids.add(item.id))
  const result: T[] = []
  for (const id of ids) {
    const merged = mergeItem(
      base.find(item => item.id === id),
      local.find(item => item.id === id),
      remote.find(item => item.id === id)
    )
    if (merged) result.push(merged)
  }
  return result
}

function mergeClaims(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): Claim[] {
  return mergeById(base.claims, local.claims, remote.claims, mergeClaim)
}

function mergeParagraphs(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): Paragraph[] {
  return mergeById(base.paragraphs, local.paragraphs, remote.paragraphs, mergeParagraph)
}

function mergeVersions(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): WorkbenchState['versions'] {
  const map = new Map<string, WorkbenchState['versions'][number]>()
  for (const v of remote.versions) map.set(v.id, clone(v))
  for (const v of local.versions) if (!map.has(v.id)) map.set(v.id, clone(v))
  return Array.from(map.values())
}

function mergeOrphanMappings(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): WorkbenchState['orphanMappings'] {
  const map = new Map<string, WorkbenchState['orphanMappings'][number]>()
  for (const v of remote.orphanMappings) map.set(v.id, clone(v))
  for (const v of local.orphanMappings) {
    if (!map.has(v.id)) map.set(v.id, clone(v))
  }
  return Array.from(map.values())
}

/** 从合并后的状态中提取待确认冲突组（仅本方副本携带组信息，避免重复） */
export function extractConflictGroups(state: WorkbenchState): ConflictGroup[] {
  const groups: ConflictGroup[] = []
  const seen = new Set<string>()
  for (const feature of state.features) {
    if (feature.conflict?.status !== 'pending' || feature.conflict.side !== 'local' || seen.has(feature.conflict.id)) continue
    const remoteFeature = state.features.find(item => item.conflict?.id === feature.conflict!.id && item.conflict.side === 'remote')
    if (!remoteFeature) continue
    seen.add(feature.conflict.id)
    groups.push({
      id: feature.conflict.id,
      originalId: feature.conflict.originalId,
      fields: feature.conflict.fields,
      localFeature: feature,
      remoteFeature
    })
  }
  return groups
}

/**
 * 三路合并：base = 双方共同看到的基准修订，local = 本方状态，remote = 对方已保存的状态。
 * UI 选择类字段（角色、选中项、当前标签页）属于本标签页，不参与合并。
 */
export function mergeStates(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): WorkbenchState {
  return {
    ...clone(remote),
    claims: mergeClaims(base, local, remote),
    paragraphs: mergeParagraphs(base, local, remote),
    features: mergeFeatures(base, local, remote),
    annotations: mergeAnnotations(base, local, remote),
    orphanMappings: mergeOrphanMappings(base, local, remote),
    versions: mergeVersions(base, local, remote),
    // 以下字段属于本标签页，保留本方
    role: local.role,
    currentUserRole: local.currentUserRole,
    selectedClaimId: local.selectedClaimId,
    selectedFeatureId: local.selectedFeatureId,
    activeTab: local.activeTab
  }
}

/** 数据实体是否与对方一致（一致则无需写入新修订，避免标签页间来回触发） */
export function dataEquals(a: WorkbenchState, b: WorkbenchState): boolean {
  return deepEqual(
    { claims: a.claims, paragraphs: a.paragraphs, features: a.features, annotations: a.annotations, orphanMappings: a.orphanMappings, versions: a.versions },
    { claims: b.claims, paragraphs: b.paragraphs, features: b.features, annotations: b.annotations, orphanMappings: b.orphanMappings, versions: b.versions }
  )
}
