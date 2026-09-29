import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Observable } from 'rxjs'
import type {
  Annotation, Claim, ClaimVersion, Feature, Paragraph, Position,
  Role, ValidationIssue, WorkbenchState
} from './models'
import {
  diffDocs, mergeDocs, normalizeDocs, type ChangeMask, type EditorMeta, type WorkbenchDocs
} from './merge-engine'

const SHARED_KEY = 'patent-claim-mapping-workbench-v2'
const LEGACY_STATE_KEY = 'patent-claim-mapping-workbench-v1'
const SESSION_PREFIX = 'patent-claim-mapping-session-v2:'
const POSITION_KEY = 'patent-claim-mapping-position-v1'
const HISTORY_LIMIT = 60
const UNDO_LIMIT = 40
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const ROLE_NAMES: Record<Role, string> = { author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' }

/** 共享案件信封：所有标签页共同读写，保存按 revision 乐观并发 */
interface SharedEnvelope {
  schema: 2
  revision: number
  docs: WorkbenchDocs
  /** 最近修订的文档快照，供落后方用“自己看到的修订号”取回基准做三方合并 */
  history: Array<{ revision: number; docs: WorkbenchDocs; editor: EditorMeta }>
  /** 当前修订落盘的作者（仅供读取展示） */
  lastEditor: EditorMeta
}

interface UiState {
  role: Role
  currentUserRole: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
}

/**
 * 一条撤销/重做历史。
 * - undoRevision：这一步正向提交之前，本地所基于的修订号；撤销恢复 docs 时以它做三方合并基准；
 * - redoRevision：这一步正向提交之后落盘成的修订号；重做恢复 docs 时以它做三方合并基准。
 * 这样重开浏览器或对端已提交新修订后，撤销重做仍只并入这一步自己动过的内容。
 */
interface HistoryEntry {
  docs: WorkbenchDocs
  undoRevision: number
  redoRevision: number
  /** 正向这一步的字段级改动掩码 */
  mask: ChangeMask
}

/** ChangeMask 的可 JSON 序列化形态（Map/Set 落盘后为普通对象/数组） */
interface SerializedMask {
  fields: Record<string, string[]>
  added: Array<[string, unknown]>
  deleted: string[]
}
interface SerializedHistoryEntry {
  docs: WorkbenchDocs
  undoRevision: number
  redoRevision: number
  mask: SerializedMask
}

function serializeMask(mask: ChangeMask): SerializedMask {
  return {
    fields: Object.fromEntries(mask.fields.entries()),
    added: Array.from(mask.added.entries()),
    deleted: Array.from(mask.deleted)
  }
}

function deserializeMask(raw: SerializedMask | ChangeMask): ChangeMask {
  if (raw.fields instanceof Map && raw.added instanceof Map && raw.deleted instanceof Set) {
    return raw as ChangeMask
  }
  const serialized = raw as SerializedMask
  return {
    fields: new Map(Object.entries(serialized.fields || {})),
    added: new Map((serialized.added || []) as Array<[string, unknown]>),
    deleted: new Set(serialized.deleted || [])
  }
}

/** 单个标签页（浏览器会话）的本地信封：撤销重做栈与界面状态，重开浏览器后按客户端继承 */
interface SessionEnvelope {
  schema: 2
  tabId: string
  updatedAt: string
  baseRevision: number
  ui: UiState
  past: SerializedHistoryEntry[]
  future: SerializedHistoryEntry[]
}

const initialClaims: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]
const initialParagraphs: Paragraph[] = [
  { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
  { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
  { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
  { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
  { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
]
const initialFeatures: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author', conflicts: [] },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author', conflicts: [] },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author', conflicts: [] },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author', conflicts: [] },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author', conflicts: [] },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author', conflicts: [] }
]
const initialAnnotations: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]

function demoDocs(): WorkbenchDocs {
  return {
    claims: structuredClone(initialClaims),
    paragraphs: structuredClone(initialParagraphs),
    features: structuredClone(initialFeatures),
    annotations: structuredClone(initialAnnotations),
    orphanMappings: [],
    versions: []
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
/** 多标签页可能在同一毫秒保存，id 带随机后缀避免撞号导致实体被误合并 */
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private docs: WorkbenchDocs
  private baseRevision: number
  private ui: UiState
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  private readonly tabId: string

  private stateSubject: BehaviorSubject<WorkbenchState>
  private historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })

  readonly state$: Observable<WorkbenchState>
  readonly history$ = this.historySubject.asObservable()
  readonly claims$: Observable<Claim[]>
  readonly paragraphs$: Observable<Paragraph[]>
  readonly features$: Observable<Feature[]>
  readonly annotations$: Observable<Annotation[]>
  readonly role$: Observable<Role>
  readonly selectedClaim$: Observable<Claim | undefined>
  readonly selectedFeature$: Observable<Feature | null>
  readonly issues$: Observable<ValidationIssue[]>

  constructor() {
    const boot = this.bootstrap()
    this.docs = boot.docs
    this.baseRevision = boot.revision
    this.ui = boot.ui
    this.past = boot.past
    this.future = boot.future
    this.tabId = boot.tabId

    this.stateSubject = new BehaviorSubject<WorkbenchState>(this.assembleState())
    this.state$ = this.stateSubject.asObservable()
    this.claims$ = this.state$.pipe(map(state => state.claims))
    this.paragraphs$ = this.state$.pipe(map(state => state.paragraphs))
    this.features$ = this.state$.pipe(map(state => state.features))
    this.annotations$ = this.state$.pipe(map(state => state.annotations))
    this.role$ = this.state$.pipe(map(state => state.role))
    this.selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId)))
    this.selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
    this.issues$ = this.state$.pipe(map(state => this.validate(state)))

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload)
    }
    this.saveSession()
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.handleBeforeUnload)
    this.saveSession()
  }

  private handleBeforeUnload = (): void => {
    this.savePosition()
    this.saveSession()
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }
  get revision(): number { return this.baseRevision }

  // ---------- 界面状态（各标签页独立，不参与修订合并） ----------

  selectClaim(id: string): void {
    this.ui.selectedClaimId = id
    this.ui.selectedFeatureId = this.docs.features.find(feature => feature.claimId === id)?.id || null
    this.emit()
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.ui.selectedFeatureId = id
    this.emit()
    this.savePosition()
  }

  setRole(role: Role): void {
    this.ui.role = role
    this.ui.currentUserRole = role
    this.emit()
    this.saveSession()
  }

  setTab(tab: string): void {
    this.ui.activeTab = tab
    this.emit()
    this.savePosition()
  }

  // ---------- 案件文档编辑（走修订号合并提交） ----------

  updateClaim(patch: Partial<Claim>): void {
    this.commit(state => {
      const claim = state.claims.find(item => item.id === this.ui.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    this.commit(state => {
      const number = Math.max(0, ...state.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: uid('claim'), number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      this.ui.selectedClaimId = claim.id
      this.ui.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const next = state.paragraphs.length + 1
      state.paragraphs.push({ id: uid('para'), section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const paragraph = state.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      state.paragraphs = state.paragraphs.filter(item => item.id !== id)
      state.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  addFeature(): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const feature: Feature = {
        id: uid('feature'), claimId: this.ui.selectedClaimId,
        label: `新特征 ${state.features.filter(item => item.claimId === this.ui.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: this.ui.role, conflicts: []
      }
      state.features.push(feature)
      this.ui.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => state.orphanMappings.push({
        id: uid(`orphan-${paragraphId}`), featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      state.features = state.features.filter(item => item.id !== id)
      state.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      state.annotations = state.annotations.filter(item => item.featureId !== id)
      this.ui.selectedFeatureId = state.features.find(item => item.claimId === this.ui.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    this.commit(state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.ui.role
    this.commit(state => state.annotations.push({
      id: uid('annotation'), featureId, authorRole: role, authorName: ROLE_NAMES[role], text: trimmed, updatedAt: new Date().toISOString()
    }))
  }

  updateAnnotation(id: string, text: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === this.ui.role) {
        annotation.text = text
        annotation.updatedAt = new Date().toISOString()
      }
    })
  }

  deleteAnnotation(id: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === this.ui.role) state.annotations = state.annotations.filter(item => item.id !== id)
    })
  }

  createVersion(name?: string): void {
    this.commit(state => {
      state.versions.unshift({
        id: uid('version'), name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(),
        claims: clone(state.claims),
        features: clone(state.features.map(feature => ({ ...feature, conflicts: [] })))
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit(state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = clone(version.claims)
      state.features = clone(version.features)
      if (!state.claims.some(claim => claim.id === this.ui.selectedClaimId)) this.ui.selectedClaimId = state.claims[0]?.id || ''
      this.ui.selectedFeatureId = state.features.find(feature => feature.claimId === this.ui.selectedClaimId)?.id || null
    })
  }

  /**
   * 显式确认一个层级 / 依据冲突候选：
   * 采用候选值后该字段冲突标记为 confirmed；之后该字段再被改动会重新待确认。
   */
  resolveConflict(featureId: string, conflictId: string, candidateId: string): void {
    if (this.ui.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      const conflict = feature?.conflicts.find(item => item.id === conflictId)
      const candidate = conflict?.candidates.find(item => item.id === candidateId)
      if (!feature || !conflict || !candidate) return
      if (conflict.field === 'parentId') feature.parentId = candidate.value as string | null
      else feature.supportIds = clone(candidate.value as string[])
      conflict.status = 'confirmed'
    })
  }

  // ---------- 撤销 / 重做（历史栈持久化，重开浏览器仍可继续） ----------

  undo(): void {
    const entry = this.past.pop()
    if (!entry) return
    const current = clone(this.docs)
    const currentRevision = this.baseRevision
    // 工作副本可能比被撤销步骤领先多个本步（连续撤销、或重开后首次撤销）：
    // 基准/远端前序都取目标态修订（entry.undoRevision）的快照，
    // 掩码累积覆盖“目标态之后所有尚未撤销的本步”，这些本步整体视为本地撤销内容。
    const intervening = this.past.filter(item => item.redoRevision > entry.redoRevision && item.redoRevision <= currentRevision)
    const mask = this.combineMasks([entry.mask, ...intervening.map(item => item.mask)])
    const targetBase = this.findRevisionDocs(entry.undoRevision)
    const result = this.syncWrite(clone(entry.docs), { mask, baseRevision: entry.undoRevision, headPrev: targetBase })
    this.future.push({ docs: current, undoRevision: entry.undoRevision, redoRevision: currentRevision, mask })
    if (this.future.length > UNDO_LIMIT) this.future.shift()
    this.docs = result.docs
    this.baseRevision = result.revision
    this.normalizeSelection()
    this.afterHistoryChange()
  }

  redo(): void {
    const entry = this.future.pop()
    if (!entry) return
    const current = clone(this.docs)
    const currentRevision = this.baseRevision
    // 重做：基准与远端前序都是当前工作修订；掩码就是这一步（当前工作修订后恢复为一步）
    const result = this.syncWrite(clone(entry.docs), { mask: entry.mask, baseRevision: currentRevision, headPrev: this.findRevisionDocs(currentRevision) })
    this.past.push({ docs: current, undoRevision: currentRevision, redoRevision: result.revision, mask: entry.mask })
    if (this.past.length > UNDO_LIMIT) this.past.shift()
    this.docs = result.docs
    this.baseRevision = result.revision
    this.normalizeSelection()
    this.afterHistoryChange()
  }

  /** 合并多个相邻步骤的字段级掩码：字段并集、新增/删除求并 */
  private combineMasks(masks: ChangeMask[]): ChangeMask {
    const fields = new Map<string, Set<string>>()
    const added = new Map<string, unknown>()
    const deleted = new Set<string>()
    for (const mask of masks) {
      mask.fields.forEach((fieldNames, key) => {
        const set = fields.get(key) || new Set<string>()
        fieldNames.forEach(name => set.add(name))
        fields.set(key, set)
      })
      mask.added.forEach((value, key) => added.set(key, value))
      mask.deleted.forEach(key => deleted.add(key))
    }
    return {
      fields: new Map(Array.from(fields.entries()).map(([key, set]) => [key, Array.from(set)])),
      added,
      deleted
    }
  }

  private findRevisionDocs(revision: number): WorkbenchDocs | null {
    if (typeof localStorage === 'undefined') return null
    const envelope = this.readShared()
    // envelope.docs 即当前修订；history 记录的是更早修订落盘前的快照
    if (envelope.revision === revision) return envelope.docs
    return envelope.history.find(item => item.revision === revision)?.docs || null
  }

  // ---------- 位置与导入导出 ----------

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    const position: Position = {
      tab: this.ui.activeTab, claimId: this.ui.selectedClaimId,
      featureId: this.ui.selectedFeatureId, scrollY: typeof window !== 'undefined' ? window.scrollY : 0
    }
    localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    this.saveSession()
  }

  readPosition(): Position {
    const fallback: Position = { tab: this.ui.activeTab, claimId: this.ui.selectedClaimId, featureId: this.ui.selectedFeatureId, scrollY: 0 }
    if (typeof localStorage === 'undefined') return fallback
    try {
      const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null') as Position | null
      return stored ? { ...stored } : fallback
    } catch { return fallback }
  }

  exportJson(): string {
    return JSON.stringify({ ...this.snapshot, validationIssues: this.validate(this.assembleState()) }, null, 2)
  }

  exportCsv(): string {
    const state = this.stateSubject.value
    const rows = state.features.map(feature => [
      state.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      state.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => state.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => state.paragraphs.find(item => item.id === id)?.section || id).join('；')
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  validate(state = this.stateSubject.value): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const feature of state.features) {
      const parentConflict = feature.conflicts.find(item => item.field === 'parentId')
      const supportConflict = feature.conflicts.find(item => item.field === 'supportIds')

      feature.conflicts
        .filter(item => item.status === 'pending')
        .forEach(item => issues.push({
          id: item.id, severity: 'warning', type: 'merge-conflict', featureId: feature.id,
          title: `${feature.label} 的${item.field === 'parentId' ? '层级' : '说明书依据'}待确认`,
          detail: `两个标签页同时修改了该特征的${item.field === 'parentId' ? '父级层级' : '支持依据'}且取值不同，请在特征编辑区核对两份候选并确认。`
        }))

      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length && !supportConflict) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (!parentConflict && this.hasReferenceCycle(feature, state.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    state.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
    return issues
  }

  // ---------- 内部：提交、合并、持久化 ----------

  private hasReferenceCycle(start: Feature, features: Feature[]): boolean {
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (id === start.id && visited.size > 0) return true
      if (visited.has(id)) return false
      visited.add(id)
      const feature = features.find(item => item.id === id)
      if (!feature) return false
      if (feature.parentId && visit(feature.parentId)) return true
      return feature.referenceIds.some(visit)
    }
    return visit(start.id)
  }

  /** 普通编辑提交：把目标态带上当前基准修订号保存，落后则三方合并 */
  private commit(recipe: (state: WorkbenchDocs) => void): void {
    const before = clone(this.docs)
    const target = clone(this.docs)
    recipe(target)
    // 层级或依据被再次改动时，原先标出的待确认（含已确认）必须重新确认
    this.reopenConfirmedConflicts(before, target)
    if (JSON.stringify(before) === JSON.stringify(target)) return
    const result = this.syncWrite(normalizeDocs(target))
    const mask = diffDocs(before, target)
    this.docs = result.docs
    this.baseRevision = result.revision
    // 撤销入口：恢复到提交前本地看到的状态，基准仍是本次提交所基于的修订号
    this.past.push({ docs: before, undoRevision: result.baseRevision, redoRevision: result.revision, mask })
    if (this.past.length > UNDO_LIMIT) this.past.shift()
    this.future = []
    this.normalizeSelection()
    this.afterHistoryChange()
  }

  /**
   * 层级 / 依据字段在本次提交中发生变化，则该字段上原有的待确认记录一律回到 pending，
   * 并把本次取值补为候选（去重），保证“改动后原来标出的待确认要重新确认”。
   */
  private reopenConfirmedConflicts(before: WorkbenchDocs, target: WorkbenchDocs): void {
    const editor = this.localEditor()
    for (const targetFeature of target.features) {
      const beforeFeature = before.features.find(item => item.id === targetFeature.id)
      if (!beforeFeature) continue
      const changedFields: Array<'parentId' | 'supportIds'> = []
      if (beforeFeature.parentId !== targetFeature.parentId) changedFields.push('parentId')
      if (JSON.stringify(beforeFeature.supportIds) !== JSON.stringify(targetFeature.supportIds)) changedFields.push('supportIds')
      for (const field of changedFields) {
        const previousConflict = beforeFeature.conflicts.find(item => item.field === field)
        const conflict = targetFeature.conflicts.find(item => item.field === field)
        if (!conflict) continue
        // 只有改动前已经确认过的冲突才需要因再次改动而重新确认；本来就待确认的无需翻转
        if (previousConflict?.status === 'confirmed') conflict.status = 'pending'
        const value: string | string[] | null = field === 'parentId' ? targetFeature.parentId : targetFeature.supportIds
        if (!conflict.candidates.some(candidate => JSON.stringify(candidate.value) === JSON.stringify(value))) {
          conflict.candidates.push({
            id: `${conflict.id}-c${conflict.candidates.length + 1}`,
            authorRole: editor.role, authorName: editor.name,
            value: field === 'parentId' ? clone(targetFeature.parentId) : clone(targetFeature.supportIds),
            at: editor.at
          })
        }
      }
    }
  }

  /**
   * 按修订号保存：读取共享信封，若自己看到的修订号已落后，
   * 只把自己相对基准动过的字段并入远端最新修订；批注按作者各自保留。
   */
  private syncWrite(
    target: WorkbenchDocs,
    options: { mask?: ChangeMask; baseRevision?: number; headPrev?: WorkbenchDocs | null } = {}
  ): { docs: WorkbenchDocs; revision: number; baseRevision: number } {
    if (typeof localStorage === 'undefined') return { docs: target, revision: this.baseRevision, baseRevision: this.baseRevision }
    const envelope = this.readShared()
    const localEditor = this.localEditor()
    const seenRevision = options.baseRevision ?? this.baseRevision
    const mask = options.mask
    let merged: WorkbenchDocs
    let remoteEditor: EditorMeta | undefined

    if (envelope.revision === seenRevision) {
      // 自己看到的就是最新修订：直接落盘
      merged = target
    } else {
      // 已落后：取回自己当时看到的修订快照做三方合并，只并入自己动过的字段
      const snapshot = envelope.history.find(item => item.revision === seenRevision)
      const base = snapshot ? snapshot.docs : null
      const latestRemote = envelope.history[envelope.history.length - 1]
      remoteEditor = latestRemote
        ? { role: latestRemote.editor.role, name: latestRemote.editor.name, at: latestRemote.editor.at }
        : undefined
      merged = mergeDocs(base, envelope.docs, target, localEditor, { mask, remoteEditor, headPrev: options.headPrev })
    }

    // 落盘前把当前信封状态按它自己的修订号记入历史，供后来的落后标签页取回基准快照
    if (!envelope.history.some(item => item.revision === envelope.revision)) {
      envelope.history.push({ revision: envelope.revision, docs: clone(envelope.docs), editor: clone(envelope.lastEditor) })
    }
    if (envelope.history.length > HISTORY_LIMIT) envelope.history.splice(0, envelope.history.length - HISTORY_LIMIT)
    const newRevision = envelope.revision + 1
    envelope.revision = newRevision
    envelope.docs = normalizeDocs(merged)
    envelope.lastEditor = { role: localEditor.role, name: localEditor.name, at: localEditor.at }
    localStorage.setItem(SHARED_KEY, JSON.stringify(envelope))
    return { docs: envelope.docs, revision: newRevision, baseRevision: seenRevision }
  }

  private localEditor(): EditorMeta {
    return { role: this.ui.role, name: ROLE_NAMES[this.ui.role], at: new Date().toISOString() }
  }

  private afterHistoryChange(): void {
    this.historySubject.next({ past: this.past.length, future: this.future.length })
    this.emit()
    this.saveSession()
  }

  private emit(): void {
    this.stateSubject.next(this.assembleState())
    this.saveSession()
  }

  private assembleState(): WorkbenchState {
    return {
      ...clone(this.docs),
      role: this.ui.role,
      currentUserRole: this.ui.currentUserRole,
      selectedClaimId: this.ui.selectedClaimId,
      selectedFeatureId: this.ui.selectedFeatureId,
      activeTab: this.ui.activeTab,
      revision: this.baseRevision
    }
  }

  private normalizeSelection(): void {
    if (!this.docs.claims.some(claim => claim.id === this.ui.selectedClaimId)) {
      this.ui.selectedClaimId = this.docs.claims[0]?.id || ''
    }
    if (this.ui.selectedFeatureId && !this.docs.features.some(feature => feature.id === this.ui.selectedFeatureId)) {
      this.ui.selectedFeatureId = this.docs.features.find(feature => feature.claimId === this.ui.selectedClaimId)?.id || null
    }
  }

  // ---------- 启动 / 迁移 / 会话 ----------

  private bootstrap(): {
    docs: WorkbenchDocs; revision: number; ui: UiState; past: HistoryEntry[]; future: HistoryEntry[]; tabId: string
  } {
    if (typeof localStorage === 'undefined') {
      const docs = demoDocs()
      return {
        docs, revision: 0,
        ui: { role: 'author', currentUserRole: 'author', selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b', activeTab: 'mapping' },
        past: [], future: [], tabId: 'tab-no-storage'
      }
    }

    // 旧版整份覆盖存储：没有修订号，打开时兼容接入为修订号 0 的共享信封
    this.migrateLegacyState()

    const envelope = this.readShared()
    const inherited = this.inheritSession(envelope.revision)
    const tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    const ui: UiState = inherited?.ui || {
      role: 'author', currentUserRole: 'author',
      selectedClaimId: envelope.docs.claims[0]?.id || '',
      selectedFeatureId: envelope.docs.features[0]?.id || null,
      activeTab: 'mapping'
    }
    // 撤销重做栈随会话持久化：Map/Set 从 JSON 恢复
    const past = (inherited?.past || []).map(entry => ({ docs: normalizeDocs(entry.docs), undoRevision: entry.undoRevision, redoRevision: entry.redoRevision, mask: deserializeMask(entry.mask) }))
    const future = (inherited?.future || []).map(entry => ({ docs: normalizeDocs(entry.docs), undoRevision: entry.undoRevision, redoRevision: entry.redoRevision, mask: deserializeMask(entry.mask) }))

    this.pruneSessions()
    return { docs: envelope.docs, revision: envelope.revision, ui, past, future, tabId }
  }

  private migrateLegacyState(): void {
    if (localStorage.getItem(SHARED_KEY)) return
    let legacy: Partial<WorkbenchState> | null = null
    try {
      const raw = localStorage.getItem(LEGACY_STATE_KEY)
      legacy = raw ? JSON.parse(raw) : null
    } catch { legacy = null }
    if (!legacy) return
    const docs = normalizeDocs(legacy)
    const editor: EditorMeta = { role: legacy.role || 'author', name: ROLE_NAMES[legacy.role || 'author'], at: new Date(0).toISOString() }
    const envelope: SharedEnvelope = { schema: 2, revision: 0, docs, history: [{ revision: 0, docs: clone(docs), editor }], lastEditor: editor }
    localStorage.setItem(SHARED_KEY, JSON.stringify(envelope))
    localStorage.removeItem(LEGACY_STATE_KEY)
  }

  private readShared(): SharedEnvelope {
    let parsed: SharedEnvelope | null = null
    try {
      const raw = localStorage.getItem(SHARED_KEY)
      parsed = raw ? JSON.parse(raw) : null
    } catch { parsed = null }

    if (parsed && parsed.schema === 2 && parsed.docs) {
      parsed.docs = normalizeDocs(parsed.docs)
      parsed.history = (parsed.history || []).map(item => ({ ...item, docs: normalizeDocs(item.docs) }))
      if (!parsed.lastEditor) {
        parsed.lastEditor = { role: 'author', name: ROLE_NAMES.author, at: new Date(0).toISOString() }
      }
      return parsed
    }

    const docs = demoDocs()
    const editor: EditorMeta = { role: 'author', name: ROLE_NAMES.author, at: new Date(0).toISOString() }
    const fresh: SharedEnvelope = { schema: 2, revision: 0, docs, history: [{ revision: 0, docs: clone(docs), editor }], lastEditor: editor }
    localStorage.setItem(SHARED_KEY, JSON.stringify(fresh))
    return fresh
  }

  private inheritSession(currentRevision: number): Omit<SessionEnvelope, 'schema' | 'tabId' | 'updatedAt'> | null {
    const candidates: SessionEnvelope[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(SESSION_PREFIX)) continue
      try {
        const session = JSON.parse(localStorage.getItem(key) || 'null') as SessionEnvelope | null
        if (session?.schema === 2) candidates.push(session)
      } catch { /* 忽略损坏会话 */ }
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const newest = candidates[0]
    if (!newest) return null
    // 栈里记录的基准修订号不能比共享信封更新（异常数据），保险起见仅在不领先时继承撤销重做栈
    if (newest.baseRevision > currentRevision) return { ...newest, past: [], future: [] }
    return newest
  }

  private pruneSessions(): void {
    const now = Date.now()
    const removable: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(SESSION_PREFIX)) continue
      try {
        const session = JSON.parse(localStorage.getItem(key) || 'null') as SessionEnvelope | null
        if (!session || now - new Date(session.updatedAt).getTime() > SESSION_TTL_MS) removable.push(key)
      } catch { removable.push(key) }
    }
    removable.forEach(key => localStorage.removeItem(key))
  }

  private saveSession(): void {
    if (typeof localStorage === 'undefined') return
    const envelope: SessionEnvelope = {
      schema: 2,
      tabId: this.tabId,
      updatedAt: new Date().toISOString(),
      baseRevision: this.baseRevision,
      ui: clone(this.ui),
      past: this.past.map(entry => ({ docs: clone(entry.docs), undoRevision: entry.undoRevision, redoRevision: entry.redoRevision, mask: serializeMask(entry.mask) })),
      future: this.future.map(entry => ({ docs: clone(entry.docs), undoRevision: entry.undoRevision, redoRevision: entry.redoRevision, mask: serializeMask(entry.mask) }))
    }
    localStorage.setItem(`${SESSION_PREFIX}${this.tabId}`, JSON.stringify(envelope))
  }
}
