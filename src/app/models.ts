export type Role = 'author' | 'examiner' | 'viewer'

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

/** 层级或说明书依据发生合并冲突时涉及的特征字段 */
export type FeatureConflictField = 'parentId' | 'supportIds'

/** 冲突字段的一个候选取值（来自某个标签页的某位作者；remote 表示无法回溯具体作者的对端标签页） */
export interface ConflictCandidate {
  id: string
  authorRole: Role | 'remote'
  authorName: string
  /** parentId 冲突时为 string | null；supportIds 冲突时为 string[] */
  value: string | string[] | null
  at: string
}

/** 同一特征的层级或依据被两边同时改动后留下的待确认记录 */
export interface PendingFeatureConflict {
  id: string
  field: FeatureConflictField
  /** pending：等待人工确认；confirmed：已显式采用某候选，之后该字段再被修改会重新待确认 */
  status: 'pending' | 'confirmed'
  candidates: ConflictCandidate[]
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
  /** 该特征上尚未消解的层级/依据合并冲突；旧数据没有该字段，载入时补空数组 */
  conflicts: PendingFeatureConflict[]
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
  /** 当前工作副本基于的共享数据修订号 */
  revision: number
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature' | 'merge-conflict'
  featureId?: string
  title: string
  detail: string
}
