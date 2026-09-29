import type {
  Annotation, Claim, ClaimVersion, Feature, FeatureConflictField, OrphanMapping,
  Paragraph, PendingFeatureConflict, Role
} from './models'

/** 参与本地保存合并的全部案件文档；UI 状态（角色、选中项、标签页）不在其中 */
export interface WorkbenchDocs {
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
}

export interface EditorMeta {
  role: Role | 'remote'
  name: string
  at: string
}

const CONFLICT_FIELDS: FeatureConflictField[] = ['parentId', 'supportIds']

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export function normalizeDocs(raw: Partial<WorkbenchDocs> | null | undefined): WorkbenchDocs {
  const features = (raw?.features || []).map(feature => ({ ...feature, conflicts: feature.conflicts || [] }))
  return {
    claims: raw?.claims || [],
    paragraphs: raw?.paragraphs || [],
    features,
    annotations: raw?.annotations || [],
    orphanMappings: raw?.orphanMappings || [],
    versions: raw?.versions || []
  }
}

function pushCandidate(conflict: PendingFeatureConflict, value: unknown, editor: EditorMeta): void {
  if (conflict.candidates.some(candidate => jsonEqual(candidate.value, value))) return
  conflict.candidates.push({
    id: `${conflict.id}-c${conflict.candidates.length + 1}`,
    authorRole: editor.role,
    authorName: editor.name,
    value: value as string | string[] | null,
    at: editor.at
  })
}

/**
 * 本地改动掩码：撤销 / 重做时，目标态里的字段值可能与基准完全相同，
 * 普通三方比较无法把“撤销回原值”与“没动过”区分开，因此显式带上本次改动的实体与字段。
 * key 形如 `features:feature-1`。
 */
export interface ChangeMask {
  fields: Map<string, string[]>
  added: Map<string, unknown>
  deleted: Set<string>
}

const COLLECTION_KEYS = ['claims', 'paragraphs', 'features', 'annotations', 'orphanMappings', 'versions'] as const
type CollectionKey = (typeof COLLECTION_KEYS)[number]

function entityKey(collection: CollectionKey, id: string): string {
  return `${collection}:${id}`
}

/** 从提交前后两份文档求本地改动掩码（字段级），用于撤销 / 重做合并 */
export function diffDocs(before: WorkbenchDocs, after: WorkbenchDocs): ChangeMask {
  const fields = new Map<string, string[]>()
  const added = new Map<string, unknown>()
  const deleted = new Set<string>()
  for (const collection of COLLECTION_KEYS) {
    const beforeItems = before[collection] as Entity[]
    const afterItems = after[collection] as Entity[]
    const beforeById = new Map(beforeItems.map(item => [item.id, item]))
    const afterById = new Map(afterItems.map(item => [item.id, item]))
    for (const item of afterItems) {
      const key = entityKey(collection, item.id)
      const old = beforeById.get(item.id)
      if (!old) {
        added.set(key, item)
        continue
      }
      const changed = Object.keys(item).filter(name => !jsonEqual((item as Record<string, unknown>)[name], (old as Record<string, unknown>)[name]))
      if (changed.length) fields.set(key, changed)
    }
    for (const item of beforeItems) {
      if (!afterById.has(item.id)) deleted.add(entityKey(collection, item.id))
    }
  }
  return { fields, added, deleted }
}

function maskChanged(mask: ChangeMask | undefined, key: string, field: string): boolean {
  return !!mask?.fields.get(key)?.includes(field)
}

function newConflict(field: FeatureConflictField): PendingFeatureConflict {
  return {
    id: `conflict-${field}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    field,
    status: 'pending',
    candidates: []
  }
}

type SideChange = { changed: boolean; conflict?: PendingFeatureConflict }

/**
 * 单字段四方合并：
 * - base     本地保存所看到的修订（撤销/重做时为该步前向提交前的快照）
 * - headPrev 远端当前修订的直接前序（撤销/重做时为该步前向落盘态）
 * - head     远端当前修订
 * - target   本地目标态（撤销时为该步之前的状态）
 *
 * headPrev→head 与 base→target 描述的若是“同一段变化”（撤销/重做自己那步），
 * 以本地撤销/重做意图为准；若对端在该步之后又改了同一字段，则按真正并发分叉处理
 * （层级/依据留双份待确认，其他字段以远端为准）。
 */
function mergeFieldValue(
  field: keyof Feature,
  baseValue: unknown,
  headPrevValue: unknown,
  headValue: unknown,
  targetValue: unknown,
  headPrevSide: SideChange,
  headSide: SideChange,
  targetSide: SideChange,
  editor: EditorMeta,
  remoteEditor: EditorMeta,
  mask: ChangeMask | undefined
): { value: unknown; conflict?: PendingFeatureConflict } {
  const remoteChangedSinceBase = !jsonEqual(baseValue, headValue)
  // 普通保存（无掩码）：对端自基准起的变化即并发分叉。
  // 撤销/重做（有掩码）：被掩码字段上，headPrev→head 的差异是被回滚的本步变化，
  // 仅当基准与前序不一致（对端在更早的本步已参与过该字段）时才视为并发分叉。
  const remoteConcurrent = mask
    ? !jsonEqual(headPrevValue, headValue) && !jsonEqual(baseValue, headPrevValue)
    : remoteChangedSinceBase

  if (targetSide.changed && !remoteConcurrent) {
    // 只有本地动过（普通保存下对端没改；撤销/重做下对端在本步之后没再改）：本地优先
    const previous = targetSide.conflict || headSide.conflict || headPrevSide.conflict
    if (previous) {
      const conflict: PendingFeatureConflict = { ...previous, status: 'pending', candidates: previous.candidates.map(item => ({ ...item })) }
      pushCandidate(conflict, targetValue, editor)
      return { value: targetValue, conflict }
    }
    return { value: targetValue }
  }
  if (!targetSide.changed && !remoteConcurrent) {
    // 两边都没动：沿用远端
    return { value: headValue, conflict: headSide.conflict || headPrevSide.conflict || targetSide.conflict }
  }
  if (!targetSide.changed) {
    // 本地没动（含撤销场景下该字段不在掩码里）：远端优先
    return { value: headValue, conflict: headSide.conflict || targetSide.conflict }
  }

  // 本地动了，对端也动了：真正并发分叉
  if (jsonEqual(headValue, targetValue)) {
    const previous = targetSide.conflict || headSide.conflict || headPrevSide.conflict
    if (previous) {
      const status = headSide.conflict?.status === 'confirmed' && targetSide.conflict?.status === 'confirmed' ? 'confirmed' : 'pending'
      return { value: headValue, conflict: { ...previous, status } }
    }
    return { value: headValue }
  }
  if (!(CONFLICT_FIELDS as string[]).includes(field)) return { value: headValue }

  const previous = targetSide.conflict || headPrevSide.conflict || headSide.conflict
  const conflict = previous
    ? { ...previous, status: 'pending' as const, candidates: previous.candidates.map(item => ({ ...item })) }
    : newConflict(field as FeatureConflictField)
  pushCandidate(conflict, headValue, remoteEditor)
  pushCandidate(conflict, targetValue, editor)
  return { value: targetValue, conflict }
}

/** 合并单个技术特征：层级与依据按字段四方合并，其余字段也只在本地动过时才并入 */
function mergeFeature(
  base: Feature | undefined,
  headPrev: Feature | undefined,
  head: Feature | undefined,
  target: Feature,
  editor: EditorMeta,
  remoteEditor: EditorMeta,
  mask: ChangeMask | undefined,
  key: string
): Feature {
  // 基准快照缺失时以远端前序兜底：本地只会并入与远端不同的字段
  const baseFeature = base || (headPrev as Feature)
  const headPrevFeature = headPrev || (head as Feature)
  const headFeature = head || headPrevFeature
  const result: Feature = { ...target, conflicts: [] }

  const fields: Array<keyof Feature> = ['claimId', 'label', 'text', 'parentId', 'referenceIds', 'supportIds', 'ownerRole']
  for (const field of fields) {
    const baseValue = baseFeature[field]
    const headPrevValue = headPrevFeature[field]
    const headValue = headFeature[field]
    const targetValue = target[field]
    const localDiffers = !jsonEqual(baseValue, targetValue)
    const headPrevSide: SideChange = {
      changed: !jsonEqual(baseValue, headPrevValue),
      conflict: (headPrevFeature.conflicts || []).find(item => item.field === field)
    }
    const headSide: SideChange = {
      changed: !jsonEqual(baseValue, headValue),
      conflict: (headFeature.conflicts || []).find(item => item.field === field)
    }
    const targetSide: SideChange = {
      changed: mask ? (maskChanged(mask, key, field) || localDiffers) : localDiffers,
      conflict: (target.conflicts || []).find(item => item.field === field)
    }
    const { value, conflict } = mergeFieldValue(
      field, baseValue, headPrevValue, headValue, targetValue, headPrevSide, headSide, targetSide, editor, remoteEditor, mask
    )
    ;(result as unknown as Record<string, unknown>)[field] = value
    if (conflict) {
      // 把各侧原记录中的候选都并入（去重按取值），再交由 mergeFieldValue 补新候选
      for (const source of [targetSide.conflict, headPrevSide.conflict, headSide.conflict]) {
        if (!source) continue
        for (const candidate of source.candidates) {
          if (!conflict.candidates.some(item => jsonEqual(item.value, candidate.value))) {
            conflict.candidates.push({ ...candidate })
          }
        }
      }
      result.conflicts.push(conflict)
    }
  }
  return result
}

type Entity = { id: string }

function mergeCollection<T extends Entity>(
  collection: CollectionKey,
  baseItems: T[], headPrevItems: T[], headItems: T[], targetItems: T[],
  mergeEntity: (base: T | undefined, head: T | undefined, target: T, key: string) => T | undefined,
  mask: ChangeMask | undefined
): T[] {
  const ids = Array.from(new Set([
    ...baseItems.map(item => item.id), ...headPrevItems.map(item => item.id),
    ...headItems.map(item => item.id), ...targetItems.map(item => item.id)
  ]))
  const merged: T[] = []
  for (const id of ids) {
    const key = entityKey(collection, id)
    const base = baseItems.find(item => item.id === id)
    const headPrev = headPrevItems.find(item => item.id === id)
    const head = headItems.find(item => item.id === id)
    const target = targetItems.find(item => item.id === id)
    const wasAddedByLocal = !!mask?.added.has(key)
    const wasDeletedByLocal = !!mask?.deleted.has(key)

    if (target && head) {
      const mergedEntity = mergeEntity(base, head, target, key)
      if (mergedEntity) merged.push(mergedEntity)
    } else if (target && !head) {
      // 远端当前没有该实体
      if (!headPrev) {
        // 远端前序也没有：本地新增（无掩码）或掩码确认新增时并入；否则不复活远端已删实体
        if (!mask || wasAddedByLocal) merged.push(target)
      } else if (mask) {
        // 撤销/重做：掩码明确动过（新增或字段改动）才保留本地版本
        if (wasAddedByLocal || mask.fields.has(key)) merged.push(target)
        // 否则远端删除生效
      } else {
        // 普通保存：本地相对基准没改过则尊重远端删除；改过则保留本地工作
        if (base && !jsonEqual(base, target)) merged.push(target)
      }
    } else if (!target && head) {
      // 本地目标没有该实体
      if (!headPrev) {
        // 远端在本步之后新增：本地未明确删除则并入
        if (!wasDeletedByLocal) merged.push(head)
      } else if (mask) {
        // 撤销/重做：本地明确删除且远端本步之后没再改，删除才生效
        if (!(wasDeletedByLocal && jsonEqual(headPrev, head))) merged.push(head)
      } else {
        // 普通保存：远端相对基准没改过则尊重本地删除；改过则保留远端工作
        if (base && !jsonEqual(base, head)) merged.push(head)
      }
    }
    // 两边都不存在：无需处理
  }
  // 保持目标态顺序，远端带来的新实体追加在后
  merged.sort((a, b) => {
    const ai = targetItems.findIndex(item => item.id === a.id)
    const bi = targetItems.findIndex(item => item.id === b.id)
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
  return merged
}

export interface MergeOptions {
  /** 撤销 / 重做时显式给出的本次本地改动掩码 */
  mask?: ChangeMask
  /** 远端较新修订的作者（取自修订记录），用于冲突候选署名；缺省显示为“另一标签页” */
  remoteEditor?: EditorMeta
  /**
   * 远端当前修订的直接前序快照。
   * 普通落后保存时就是本地基准；撤销/重做时传入本步前向落盘（redoRevision）的快照，
   * 这样“自己这步产生的结果”不会被误判为对端改动，字段与实体存续判定才能正确。
   */
  headPrev?: WorkbenchDocs | null
}

/**
 * 四方合并案件文档。
 * @param base   落后方保存时所看到的修订（撤销/重做时为该步前向提交前快照）
 * @param head   共享存储中已经落盘的较新修订
 * @param target 落后方想要保存的目标态（只并入它相对基准真正动过的字段）
 * @param editor 落后方作者信息，用于冲突候选署名
 * @param options.headPrev 远端当前修订的直接前序；普通落后保存省略（=base），撤销/重做必填
 * base 为 null 表示基准修订快照已被裁剪，按“以远端为基准、仅并入差异”的保守策略兜底。
 */
export function mergeDocs(
  base: WorkbenchDocs | null,
  head: WorkbenchDocs,
  target: WorkbenchDocs,
  editor: EditorMeta,
  options: MergeOptions = {}
): WorkbenchDocs {
  const baseline = base ? normalizeDocs(base) : normalizeDocs(head)
  const headPrevDocs = options.headPrev !== undefined ? (options.headPrev ? normalizeDocs(options.headPrev) : normalizeDocs(head)) : baseline
  const mask = options.mask
  const remoteEditor: EditorMeta = options.remoteEditor || { role: 'remote', name: '另一标签页', at: new Date(0).toISOString() }

  // 非层级/依据标量字段：本地动了且对端没有并发改动才取本地；否则远端优先
  const scalarValue = (b: unknown, prev: unknown, h: unknown, t: unknown, changedLocal: boolean): unknown => {
    const remoteConcurrent = mask ? !jsonEqual(prev, h) : !jsonEqual(b, h)
    if (changedLocal && !remoteConcurrent) return t
    return h
  }

  const claims = mergeCollection('claims', baseline.claims, headPrevDocs.claims, head.claims, target.claims, (b, h, t, key) => {
    const prev = headPrevDocs.claims.find(item => item.id === t.id) || b
    const claim: Claim = { ...t }
    for (const field of ['number', 'title', 'text', 'independent'] as const) {
      const localChanged = mask
        ? (maskChanged(mask, key, field) || !jsonEqual(b?.[field], t[field]))
        : !jsonEqual(b?.[field], t[field])
      ;(claim as unknown as Record<string, unknown>)[field] = scalarValue(b?.[field], prev?.[field], h![field], t[field], localChanged)
    }
    return claim
  }, mask)
  const paragraphs = mergeCollection('paragraphs', baseline.paragraphs, headPrevDocs.paragraphs, head.paragraphs, target.paragraphs, (b, h, t, key) => {
    const prev = headPrevDocs.paragraphs.find(item => item.id === t.id) || b
    const paragraph: Paragraph = { ...t }
    for (const field of ['section', 'text'] as const) {
      const localChanged = mask
        ? (maskChanged(mask, key, field) || !jsonEqual(b?.[field], t[field]))
        : !jsonEqual(b?.[field], t[field])
      ;(paragraph as unknown as Record<string, unknown>)[field] = scalarValue(b?.[field], prev?.[field], h![field], t[field], localChanged)
    }
    return paragraph
  }, mask)
  const features = mergeCollection('features', baseline.features, headPrevDocs.features, head.features, target.features, (b, h, t, key) =>
    mergeFeature(b, headPrevDocs.features.find(item => item.id === t.id), h, t, editor, remoteEditor, mask, key), mask)
  // 批注按作者各留各的：权限隔离下同一条批注不会被两位作者同时编辑；撤销时本地改动优先
  const annotations = mergeCollection('annotations', baseline.annotations, headPrevDocs.annotations, head.annotations, target.annotations, (b, h, t, key) => {
    const prev = headPrevDocs.annotations.find(item => item.id === t.id) || b
    const localChanged = mask
      ? (maskChanged(mask, key, 'text') || !jsonEqual(b?.text, t.text))
      : !jsonEqual(b?.text, t.text)
    const remoteConcurrent = mask ? !jsonEqual(prev?.text, h?.text) && !jsonEqual(b?.text, prev?.text) : !jsonEqual(b?.text, h?.text)
    return localChanged && !remoteConcurrent ? t : h!
  }, mask)
  const orphanMappings = mergeCollection('orphanMappings', baseline.orphanMappings, headPrevDocs.orphanMappings, head.orphanMappings, target.orphanMappings, (_b, _h, t) => t, mask)
  // 版本快照只追加：远端新增的历史即使本地落后也不能丢
  const versionIds = new Set<string>()
  const versions: ClaimVersion[] = []
  for (const version of [...target.versions, ...head.versions]) {
    if (!versionIds.has(version.id)) { versionIds.add(version.id); versions.push(version) }
  }

  return { claims, paragraphs, features, annotations, orphanMappings, versions }
}
