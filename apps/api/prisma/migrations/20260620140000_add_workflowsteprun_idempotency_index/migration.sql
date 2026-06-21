-- CreateIndex
CREATE INDEX "workflow_step_runs_runId_stepKey_attempt_idx" ON "workflow_step_runs"("runId", "stepKey", "attempt");

