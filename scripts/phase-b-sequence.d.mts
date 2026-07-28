export type PhaseBStage =
  | 'pre_cas_local_gates'
  | 'cas1'
  | 'd1_identity'
  | 'upload'
  | 'clean_start_reset'
  | 'clean_start_empty_verify'
  | 'remote_migration_plan'
  | 'migrations_001_006'
  | 'cas2'
  | 'traffic'
  | 'smoke_reconcile'
  | 't0'

export interface PhaseBBindings {
  candidateId: string
  approvalPacketSha256: string
  buildArchiveSha256: string
  baselineDeploymentId: string
  baselineVersionId: string
  baselineD1DatabaseId: string
  deliveryMode: 'clean-start'
  cleanStartResetSqlSha256: string
  historicalDataDisposition: Readonly<{
    productionExport: 'NOT_APPLICABLE'
    doubleRestore: 'NOT_APPLICABLE'
    historicalBaselineQueries: 'NOT_APPLICABLE'
  }>
}

export interface PhaseBExecutionContext {
  readonly configPath: string
  readonly bindings: Readonly<PhaseBBindings>
}

export const PHASE_B_STAGES: readonly PhaseBStage[]

export function runPhaseBSequence(options: {
  configPath: string
  bindings: Readonly<PhaseBBindings>
  runStage: (stage: PhaseBStage, context: Readonly<PhaseBExecutionContext>) => void | Promise<void>
}): Promise<Readonly<Record<PhaseBStage, number>>>
