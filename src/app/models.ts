export type Role = 'author' | 'examiner' | 'viewer'

/** 冲突字段：层级（父级特征）或依据（支持段落） */
export type ConflictField = 'parentId' | 'supportIds'

/**
 * 特征冲突标记。双方在各自标签页中修改了同一特征的层级或依据且不一致时，
 * 合并时保留两份特征副本，分别标记为 local（本方）与 remote（对方）。
 */
export interface FeatureConflict {
  /** 冲突组编号，同组的两份副本共用一个编号 */
  id: string
  /** 本方副本 / 对方副本 */
  side: 'local' | 'remote'
  /** 发生冲突的原始特征 id（两份副本最初的特征 id） */
  originalId: string
  /** 发生冲突的字段 */
  fields: ConflictField[]
  /** pending = 待确认；resolved = 已确认保留（保留后标记清除） */
  status: 'pending' | 'resolved'
}

export interface Claim {
  id: string
  number: number
  title: string
  text: string
  independent: boolean
}

export interface Paragraph {
  id: string
  section: string
  text: string
}

export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  supportIds: string[]
  ownerRole: Role
  /** 合并冲突标记；仅当双方对层级或依据的修改不一致时存在 */
  conflict?: FeatureConflict
}

export interface Annotation {
  id: string
  featureId: string
  authorRole: Role
  authorName: string
  text: string
  updatedAt: string
}

export interface OrphanMapping {
  id: string
  featureLabel: string
  paragraphId: string
  reason: string
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
}

export interface Position {
  tab: string
  claimId: string
  featureId: string | null
  scrollY: number
}

export interface WorkbenchState {
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  role: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
  currentUserRole: Role
  /** 数据修订号：每次保存 +1；打开无修订号的旧数据时兼容接入为 1 */
  revision: number
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature' | 'pending-conflict'
  featureId?: string
  title: string
  detail: string
}
