import {
  ApiError, demoPeriod, type Account, type Actual, type ActualInput, type Allocation, type AllocationInput,
  type ApprovalInput, type Availability, type Catalog, type CommodityPlan, type CommodityPlanInput,
  type Estimate, type EstimateInput, type Feedback, type FeedbackInput, type Observation, type ObservationInput,
  type Prediction, type PredictionInput, type Receipt, type ReceiptInput, type Risk, type RiskInput,
  type Role, type Selection, type SelectionInput,
} from './contracts'

export type Activity = {
  observations: Observation[]
  estimates: Estimate[]
  predictions: Prediction[]
  risks: Risk[]
  plans: CommodityPlan[]
  approvals: Availability[]
  actuals: Actual[]
  selections: Selection[]
}

type State = Activity & { adjustments: Allocation[]; feedback: Feedback[]; receipts: Receipt[] }
const key = 'smartharvest.simulation.v2'
const timestamp = '2026-11-26T09:05:00+07:00'

const createId = (prefix: string) => {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  const suffix = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `${prefix}-${suffix}`
}

export const simulationCatalog: Catalog = {
  farms: [{ farm_id: 'FARM-01', name: 'Kebun Demo', synthetic: true }],
  crops: [{ crop_id: 'SPINACH', name: 'Bayam', supported_by_model: true }],
  periods: [demoPeriod],
  members: [
    { member_id: 'MBR-001', name: 'Anggota 1', package_name: 'Paket Pilih', eligible: true, quota_kg: 2 },
    { member_id: 'MBR-002', name: 'Anggota 2', package_name: 'Paket Reguler', eligible: false, quota_kg: 0 },
  ],
}

function seed(): State {
  return {
    observations: [{
      farm_id: 'FARM-01', crop_id: 'SPINACH', device_id: 'SYN-ESP32-01', source: 'simulated_iot',
      provenance: 'local_simulator', observation_id: 'OBS-001', status: 'RECORDED',
      observed_at: timestamp, recorded_at: timestamp,
      measurements: [
        { type: 'air_temperature', value: 27.4, unit: 'C' },
        { type: 'relative_humidity', value: 74.5, unit: 'percent' },
        { type: 'soil_moisture_index', value: 34, unit: 'percent' },
        { type: 'pressure', value: 926.1, unit: 'hPa' },
      ],
    }],
    estimates: [{
      farm_id: 'FARM-01', crop_id: 'SPINACH', harvest_period: demoPeriod, estimated_quantity_kg: 15,
      estimate_id: 'EST-001', recorded_at: timestamp, status: 'RECORDED',
    }],
    predictions: [{
      farm_id: 'FARM-01', crop_id: 'SPINACH', target_period: demoPeriod, prediction_id: 'PRED-001',
      predicted_quantity_kg: 12.4, model_version: 'rf-synthetic-v3', source_of_training_data: 'synthetic',
      inference_route: 'manual', generated_at: timestamp, status: 'generated', requires_coordinator_review: true,
    }],
    risks: [],
    plans: [],
    approvals: [],
    actuals: [],
    selections: [],
    adjustments: [],
    feedback: [],
    receipts: [],
  }
}

let inMemory: State | undefined

export function readSimulation(): State {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return { ...seed(), ...(JSON.parse(raw) as Partial<State>) }
  } catch {
    return inMemory ?? seed()
  }
  return inMemory ?? seed()
}

const fail = (status: number, message: string, code?: string): never => { throw new ApiError(status, message, code) }

export async function simulate(account: Account, url: string, body?: unknown) {
  const handle = () => applySimulation(account, url, body)
  if (body !== undefined && navigator.locks) return navigator.locks.request(key, handle)
  return handle()
}

function buildTelemetry(observations: Observation[]) {
  const latest = observations[0]
  const readings = {
    air_temperature: latest?.measurements.find(m => m.type === 'air_temperature')?.value ?? null,
    relative_humidity: latest?.measurements.find(m => m.type === 'relative_humidity')?.value ?? null,
    soil_moisture_index: latest?.measurements.find(m => m.type === 'soil_moisture_index')?.value ?? null,
    pressure: latest?.measurements.find(m => m.type === 'pressure')?.value ?? null,
    soil_raw: latest?.measurements.find(m => m.type === 'soil_raw')?.value ?? null,
  }
  const cov = { valid_slots: observations.length ? 1 : 0, expected_slots: 672, coverage: observations.length ? 0.0015 : 0, last_seen_hours: latest ? 0.1 : null, usable: false }
  return {
    farm_id: 'FARM-01',
    status: latest ? 'stale' as const : 'unknown' as const,
    device_id: latest?.device_id ?? null,
    source: latest?.source ?? null,
    provenance: latest?.provenance ?? null,
    last_observed_at: latest?.observed_at ?? null,
    last_received_at: latest?.recorded_at ?? null,
    age_seconds: latest ? 60 : null,
    readings,
    coverage: { air_temperature: cov, relative_humidity: cov, soil_moisture_index: cov },
    observation_count_7d: observations.length,
  }
}

function applySimulation(account: Account, url: string, body?: unknown) {
  const state = readSimulation()
  const [path, query] = url.split('?')
  const params = new URLSearchParams(query)
  const period = params.get('period') ?? demoPeriod
  const now = new Date().toISOString()
  const allow = (...roles: Role[]) => {
    if (!roles.includes(account.role)) fail(403, 'Akun ini tidak memiliki izin untuk tindakan tersebut.')
  }
  const save = <T>(val: T) => {
    inMemory = state
    try { localStorage.setItem(key, JSON.stringify(state)) } catch { /* ignore */ }
    return val
  }

  if (body === undefined) {
    if (path === '/catalog') {
      return { ...simulationCatalog, members: account.role === 'COORDINATOR' ? simulationCatalog.members : [] }
    }
    if (path === '/coordinator/overview') {
      allow('COORDINATOR')
      const planting = { farm_id: 'FARM-01', crop_id: 'SPINACH', planting_id: 'PLANT-FARM01-SPINACH', planting_date: '2026-10-01', target_harvest_date: '2026-11-27', planted_area_m2: 8, plant_count: 64, synthetic: true }
      const ests = state.estimates.filter(e => e.harvest_period === period)
      const preds = state.predictions.filter(p => p.target_period === period)
      const appr = state.approvals.find(a => a.period === period) ?? null
      const act = state.actuals.find(a => a.period === period) ?? null
      return {
        period,
        plantings: [{
          planting, farm: simulationCatalog.farms[0], crop: simulationCatalog.crops[0],
          latest_estimate: ests[0] ?? null, latest_prediction: preds[0] ?? null, prediction_history: preds,
          prediction_state: preds[0] ? { farm_id: 'FARM-01', crop_id: 'SPINACH', period, status: 'ready', latest_prediction_id: preds[0].prediction_id, predicted_quantity_kg: preds[0].predicted_quantity_kg, inference_route: preds[0].inference_route, last_success_at: preds[0].generated_at } : null,
          approval: appr, actual_harvest: act, telemetry: buildTelemetry(state.observations),
        }],
        commodity_plans: state.plans.filter(p => p.period === period),
        risks: state.risks,
        approvals: state.approvals.filter(a => a.period === period),
        selections: state.selections.filter(s => s.period === period),
        adjustments: state.adjustments,
        receipts: state.receipts.filter(r => r.period === period),
        feedback: state.feedback.filter(f => f.period === period),
        members: simulationCatalog.members,
      }
    }
    if (path === '/farmer/overview') {
      allow('FARMER')
      const planting = { farm_id: 'FARM-01', crop_id: 'SPINACH', planting_id: 'PLANT-FARM01-SPINACH', planting_date: '2026-10-01', target_harvest_date: '2026-11-27', planted_area_m2: 8, plant_count: 64, synthetic: true }
      const ests = state.estimates.filter(e => e.harvest_period === period)
      const preds = state.predictions.filter(p => p.target_period === period)
      return {
        period,
        plantings: [{
          planting, farm: simulationCatalog.farms[0], crop: simulationCatalog.crops[0],
          latest_estimate: ests[0] ?? null, estimates: ests, latest_prediction: preds[0] ?? null,
          telemetry: buildTelemetry(state.observations),
        }],
        recent_observations: state.observations.slice(0, 30),
      }
    }
    if (path === '/member/overview') {
      allow('MEMBER')
      const m = simulationCatalog.members.find(x => x.member_id === account.memberId) ?? simulationCatalog.members[0]
      return {
        period,
        member: { member_id: m.member_id, name: m.name ?? m.member_id, package_name: m.package_name ?? 'Paket', eligible: m.eligible, quota_kg: m.quota_kg ?? 0 },
        availability: state.approvals.filter(a => a.period === period).map(a => ({
          availability_id: a.availability_id, farm_id: a.farm_id, crop_id: a.crop_id, period: a.period,
          approved_quantity_kg: a.approved_quantity_kg, remaining_quantity_kg: a.approved_quantity_kg,
          status: a.status, version: a.version, approved_at: a.approved_at,
        })),
        selection: state.selections.find(s => s.period === period && s.member_id === account.memberId) ?? null,
        updates: state.adjustments.flatMap(c => c.member_allocations.filter(a => a.member_id === account.memberId).map(a => ({
          adjustment_id: c.adjustment_id, availability_id: c.availability_id, farm_id: 'FARM-01', crop_id: 'SPINACH',
          quantity_kg: a.quantity_kg, reason: c.reason, version: c.version, approved_at: c.approved_at,
        }))),
        receipt: state.receipts.find(r => r.period === period && r.member_id === account.memberId) ?? null,
        feedback: state.feedback.find(f => f.period === period && f.member_id === account.memberId) ?? null,
        history: {
          selections: state.selections.filter(s => s.member_id === account.memberId),
          feedback: state.feedback.filter(f => f.member_id === account.memberId),
        },
      }
    }
    if (path === '/telemetry/summary') return buildTelemetry(state.observations)
    if (path === '/telemetry/history') {
      const range = (params.get('range') as '1h' | '24h' | '7d') ?? '24h'
      return { farm_id: 'FARM-01', range, bucket_seconds: 900, window_start: now, window_end: now, series: [] }
    }
    if (path === '/farm-observations') return { items: state.observations }
    if (path === '/approved-availability') return { items: state.approvals.filter(a => a.period === period) }
    if (path === '/member-selections') return { items: state.selections.filter(s => s.period === period) }
    if (path === '/allocation-updates') return { items: [] }
  }

  switch (path) {
    case '/farm-observations': {
      allow('FARMER')
      const input = body as ObservationInput
      const result: Observation = { ...input, observation_id: createId('OBS'), status: 'RECORDED', recorded_at: now }
      state.observations.unshift(result)
      return save(result)
    }
    case '/harvest-estimates': {
      allow('FARMER')
      const input = body as EstimateInput
      const result: Estimate = { ...input, estimate_id: createId('EST'), status: 'RECORDED', recorded_at: now }
      state.estimates.unshift(result)
      return save(result)
    }
    case '/harvest-predictions': {
      allow('COORDINATOR')
      const input = body as PredictionInput
      const result: Prediction = {
        farm_id: input.farm_id, crop_id: input.crop_id, target_period: input.target_period,
        prediction_id: createId('PRED'), predicted_quantity_kg: 12.4, model_version: 'rf-synthetic-v3',
        source_of_training_data: 'synthetic', inference_route: 'manual', generated_at: now, status: 'generated',
        requires_coordinator_review: true,
      }
      state.predictions.unshift(result)
      return save(result)
    }
    case '/commodity-plans': {
      allow('COORDINATOR')
      const input = body as CommodityPlanInput
      const pred = state.predictions.find(p => p.crop_id === input.crop_id && p.target_period === input.period)
      const total = pred ? pred.predicted_quantity_kg : 0
      const gap = Math.max(0, input.planned_demand_kg - total)
      const plan: CommodityPlan = {
        plan_id: createId('PLAN'), crop_id: input.crop_id, period: input.period, plan_version: state.plans.length + 1,
        planned_demand_kg: input.planned_demand_kg, total_supply_kg: total, shortage_gap_kg: gap,
        status: gap > 0 ? 'SHORTAGE_POSSIBLE' : 'NO_SHORTAGE_INDICATED', coverage_status: pred ? 'complete_ai' : 'incomplete',
        items: pred ? [{ farm_id: pred.farm_id, basis_type: 'PREDICTION', basis_id: pred.prediction_id, quantity_kg: pred.predicted_quantity_kg }] : [],
        review_note: input.review_note ?? '', verified_with_farmer: Boolean(input.verified_with_farmer),
        is_stale: false, reviewed_by: 'USR-COORD', reviewed_at: now,
      }
      state.plans.unshift(plan)
      return save(plan)
    }
    case '/supply-risk-assessments': {
      allow('COORDINATOR')
      const input = body as RiskInput
      const pred = state.predictions.find(p => p.prediction_id === input.prediction_id) ?? fail(404, 'Prediksi tidak ditemukan.')
      const gap = Math.max(0, input.planned_demand_kg - pred.predicted_quantity_kg)
      const res: Risk = {
        assessment_id: createId('RISK'), prediction_id: input.prediction_id, predicted_quantity_kg: pred.predicted_quantity_kg,
        planned_demand_kg: input.planned_demand_kg, shortage_gap_kg: gap,
        status: gap > 0 ? 'SHORTAGE_POSSIBLE' : 'NO_SHORTAGE_INDICATED', assessed_at: now,
      }
      state.risks.unshift(res)
      return save(res)
    }
    case '/approved-availability': {
      allow('COORDINATOR')
      const input = body as ApprovalInput
      const res: Availability = {
        ...input, availability_id: createId('AVL'), status: 'APPROVED', version: 1,
        approved_by: 'USR-COORD', approved_at: now, member_allocations: [],
      }
      state.approvals.unshift(res)
      return save(res)
    }
    case '/member-selections': {
      allow('MEMBER')
      if (!account.canSelect) fail(403, 'Paket ini tidak mencakup hak pilih.')
      const input = body as SelectionInput
      const res: Selection = { ...input, selection_id: createId('SEL'), member_id: account.memberId!, status: 'RECORDED', recorded_at: now }
      state.selections.unshift(res)
      return save(res)
    }
    case '/actual-harvests': {
      allow('COORDINATOR')
      const input = body as ActualInput
      const res: Actual = { ...input, actual_harvest_id: createId('ACT'), status: 'CONFIRMED', confirmed_by: 'USR-COORD', recorded_at: now }
      state.actuals.unshift(res)
      return save(res)
    }
    case '/allocation-adjustments': {
      allow('COORDINATOR')
      const input = body as AllocationInput
      const avl = state.approvals.find(a => a.availability_id === input.availability_id) ?? fail(404, 'Ketersediaan tidak ditemukan.')
      const res: Allocation = { ...input, adjustment_id: createId('ADJ'), version: avl.version + 1, approved_by: 'USR-COORD', approved_at: now }
      avl.version = res.version
      avl.approved_quantity_kg = res.approved_quantity_kg
      avl.member_allocations = res.member_allocations
      state.adjustments.unshift(res)
      return save(res)
    }
    case '/package-receipts': {
      allow('COORDINATOR')
      const input = body as ReceiptInput
      const res: Receipt = { receipt_id: createId('RCT'), member_id: input.member_id, period: input.period, received: input.confirmed, confirmed_by: 'USR-COORD', confirmed_at: now }
      state.receipts = [res, ...state.receipts.filter(r => r.member_id !== input.member_id || r.period !== input.period)]
      return save(res)
    }
    case '/member-feedback': {
      allow('MEMBER')
      const input = body as FeedbackInput
      if (!state.receipts.some(r => r.member_id === account.memberId && r.period === input.period && r.received)) {
        fail(409, 'Penerimaan paket belum dikonfirmasi oleh koordinator.')
      }
      const res: Feedback = { ...input, feedback_id: createId('FDB'), member_id: account.memberId!, status: 'RECORDED', recorded_at: now }
      state.feedback.unshift(res)
      return save(res)
    }
    default:
      return fail(404, 'Endpoint tidak ditemukan.')
  }
}
