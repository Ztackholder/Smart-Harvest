import test from 'node:test'
import assert from 'node:assert/strict'
import { nextCoordinatorStep } from '../src/workflow.ts'

test('waits for farm data when no estimate, observation, or prediction exists', () => {
  const step = nextCoordinatorStep({
    hasFarmData: false,
    hasEstimate: false,
    hasPrediction: false,
    hasRiskOrPlan: false,
    hasAvailability: false,
    hasActual: false,
  })
  assert.equal(step.key, 'waiting-data')
})

test('prompts manual estimate fallback when prediction unavailable and estimate exists', () => {
  const step = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: true,
    hasPrediction: false,
    predictionUnavailable: true,
    hasRiskOrPlan: false,
    hasAvailability: false,
    hasActual: false,
  })
  assert.equal(step.key, 'publish-availability')
  assert.equal(step.action, 'rencana')
})

test('requires review/demand assessment before publishing AI prediction, including stale re-review', () => {
  const unreviewed = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: false,
    hasPrediction: true,
    hasRiskOrPlan: false,
    hasAvailability: false,
    hasActual: false,
  })
  assert.equal(unreviewed.key, 'review-plan')

  const stale = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: false,
    hasPrediction: true,
    hasRiskOrPlan: true,
    planStale: true,
    hasAvailability: false,
    hasActual: false,
  })
  assert.equal(stale.key, 'review-plan')
})

test('advances after manual approval without demanding AI prediction again', () => {
  const step = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: true,
    hasPrediction: false,
    hasRiskOrPlan: false,
    hasAvailability: true,
    approvedBasisType: 'MANUAL_ESTIMATE',
    hasActual: false,
  })
  assert.equal(step.key, 'record-actual')
  assert.equal(step.action, 'alokasi-realisasi')
})

test('requires allocation adjustment when actual is below allocation, then receipt confirmation, then distinguishes operational completion from feedback', () => {
  const needAdj = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: true,
    hasPrediction: true,
    hasRiskOrPlan: true,
    hasAvailability: true,
    hasActual: true,
    actualBelowAllocation: true,
    allocationAdjustedAfterActual: false,
    allReceiptsConfirmed: false,
  })
  assert.equal(needAdj.key, 'adjust-allocation')

  const needReceipt = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: true,
    hasPrediction: true,
    hasRiskOrPlan: true,
    hasAvailability: true,
    hasActual: true,
    actualBelowAllocation: false,
    allReceiptsConfirmed: false,
  })
  assert.equal(needReceipt.key, 'confirm-receipts')

  const opsDone = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: true,
    hasPrediction: true,
    hasRiskOrPlan: true,
    hasAvailability: true,
    hasActual: true,
    actualBelowAllocation: false,
    allReceiptsConfirmed: true,
    hasFeedback: false,
  })
  assert.equal(opsDone.key, 'operational-complete')

  const allDone = nextCoordinatorStep({
    hasFarmData: true,
    hasEstimate: true,
    hasPrediction: true,
    hasRiskOrPlan: true,
    hasAvailability: true,
    hasActual: true,
    actualBelowAllocation: false,
    allReceiptsConfirmed: true,
    hasFeedback: true,
  })
  assert.equal(allDone.key, 'complete')
})
