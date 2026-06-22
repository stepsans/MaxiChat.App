// Pure: given the target column's is_finish_stage (or null/undefined when the
// task has no column), returns the derived isCompleted value. A task with no
// column is never done. This is the single source of truth for the "done"
// derivation (Model A) — both the move and PUT task routes call it so the rule
// lives in exactly one place and stays unit-testable (db-free).
export function deriveIsCompleted(
  targetColumnIsFinishStage: boolean | null | undefined
): boolean {
  return targetColumnIsFinishStage === true;
}
