import { ApiError, demoPeriod, type Account, type Actual, type ActualInput, type Allocation, type AllocationInput,
  type ApprovalInput, type Availability, type Estimate, type EstimateInput, type Feedback, type FeedbackInput,
  type Observation, type ObservationInput, type Prediction, type PredictionInput, type Risk, type RiskInput,
  type Role, type Selection, type SelectionInput } from './contracts'

export type Activity = {
  observations: Observation[]
  estimates: Estimate[]
  predictions: Prediction[]
  risks: Risk[]
  approvals: Availability[]
  actuals: Actual[]
}

export const emptyActivity: Activity = {
  observations: [], estimates: [], predictions: [], risks: [], approvals: [], actuals: [],
}

type State = Activity & { selections: Selection[]; adjustments: Allocation[]; feedback: Feedback[] }
const key = 'smartharvest.simulation.v1'
const timestamp = '2026-11-11T09:05:00+07:00'
const createId = (prefix: string) => {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  const suffix = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `${prefix}-${suffix}`
}

function seed(): State {
  const crops = ['SPINACH', 'PAKCHOY']
  const predictions: Prediction[] = crops.map((crop_id, i) => ({
    farm_id: 'FARM-01', crop_id, target_period: demoPeriod, prediction_id: `PRED-00${i + 1}`,
    predicted_quantity_kg: [12.4, 18.6][i], model_version: 'rf-demo-v1',
    source_of_training_data: 'synthetic', generated_at: timestamp, status: 'generated', requires_coordinator_review: true,
  }))
  return {
    observations: [{
      farm_id: 'FARM-01', crop_id: 'SPINACH', device_id: 'SYN-ESP32-01', source: 'simulated_iot',
      observation_id: 'OBS-001', status: 'accepted', observed_at: timestamp, recorded_at: timestamp,
      measurements: [
        { type: 'air_temperature', value: 25.4, unit: 'C' },
        { type: 'relative_humidity', value: 70, unit: 'percent' },
      ],
    }],
    estimates: [{
      farm_id: 'FARM-01', crop_id: 'SPINACH', harvest_period: demoPeriod, estimated_quantity_kg: 13,
      estimate_id: 'EST-001', recorded_at: timestamp, status: 'accepted',
    }],
    predictions,
    risks: predictions.map(({ prediction_id, predicted_quantity_kg }, i) => ({
      prediction_id, predicted_quantity_kg, planned_demand_kg: [15, 15][i],
      shortage_gap_kg: [2.6, 0][i], status: i === 0 ? 'SHORTAGE_POSSIBLE' : 'NO_SHORTAGE_INDICATED', assessed_at: timestamp,
    })),
    approvals: [{
      farm_id: 'FARM-01', crop_id: 'PAKCHOY', period: demoPeriod, approved_quantity_kg: 15,
      basis_type: 'PREDICTION', basis_id: 'PRED-002', approval_note: 'Pasokan mencukupi kebutuhan minggu ini.',
      availability_id: 'AVL-001', status: 'APPROVED', version: 1, approved_by: 'COORD-001', approved_at: '2026-11-11T09:35:00+07:00',
    }],
    actuals: [], selections: [], adjustments: [], feedback: [],
  }
}

let inMemory: State | undefined

export function readSimulation(): State {
  try {
    const value = localStorage.getItem(key)
    if (value) return JSON.parse(value) as State
  } catch {
    return inMemory ?? seed()
  }
  return inMemory ?? seed()
}

const fail = (status: number, message: string, code?: string): never => { throw new ApiError(status, message, code) }

export async function simulate(account: Account, url: string, body?: unknown) {
  const handle = () => applySimulation(account, url, body)
  // The lock keeps version checks and writes together across tabs when Web Locks is available.
  if (body !== undefined && navigator.locks) return navigator.locks.request(key, handle)
  return handle()
}

function applySimulation(account: Account, url: string, body?: unknown) {
  const state = readSimulation()
  const [path, query] = url.split('?')
  const period = new URLSearchParams(query).get('period')
  const now = new Date().toISOString()
  const allow = (...roles: Role[]) => {
    if (!roles.includes(account.role)) fail(403, 'Akun ini tidak memiliki izin untuk tindakan tersebut.')
  }
  const save = <T>(value: T) => {
    inMemory = state
    try { localStorage.setItem(key, JSON.stringify(state)) } catch { /* Continue the demo in memory. */ }
    return value
  }
  const approved = (id: string) => state.approvals.find(row => row.availability_id === id)
    ?? fail(404, 'Ketersediaan tidak ditemukan.')
  const prediction = (id: string) => state.predictions.find(row => row.prediction_id === id)
    ?? fail(404, 'Prediksi tidak ditemukan. Periksa ID prediksi.')
  const amount = (value: number) => {
    if (!Number.isFinite(value) || value < 0) fail(422, 'Kuantitas harus berupa angka nonnegatif.')
  }

  if (body === undefined) {
    if (path.startsWith('/harvest-predictions/')) {
      allow('COORDINATOR')
      return prediction(decodeURIComponent(path.split('/').at(-1)!))
    }
    if (path === '/approved-availability') {
      allow('COORDINATOR', 'MEMBER')
      return { items: state.approvals.filter(row => row.period === period) }
    }
    if (path === '/allocation-updates') {
      allow('MEMBER')
      const items = state.adjustments.flatMap(change => {
        const a = approved(change.availability_id)
        const allocation = change.member_allocations.find(row => row.member_id === account.memberId)
        if (a.period !== period || !allocation) return []
        return [{
          adjustment_id: change.adjustment_id, availability_id: a.availability_id, farm_id: a.farm_id, crop_id: a.crop_id,
          quantity_kg: allocation.quantity_kg, reason: change.reason, version: change.version, approved_at: change.approved_at,
        }]
      })
      return { items }
    }
  }

  switch (path) {
    case '/farm-observations': {
      allow('FARMER')
      const input = body as ObservationInput
      const valid = { air_temperature: ['C', -50, 65], relative_humidity: ['percent', 0, 100], soil_moisture_index: ['percent', 0, 100] } as const
      const measurementTypes = new Set(input.measurements.map(row => row.type))
      if (!input.farm_id || !Number.isFinite(Date.parse(input.observed_at)) ||
          !input.measurements.length || measurementTypes.size !== input.measurements.length ||
          (['iot', 'simulated_iot'].includes(input.source) && !input.device_id) ||
          input.measurements.some(({ type, unit, value }) => {
            const range = valid[type as keyof typeof valid]
            return !range || unit !== range[0] || !Number.isFinite(value) || value < range[1] || value > range[2]
          })) fail(422, 'Periksa jenis, satuan, rentang pengukuran, dan ID perangkat.', 'INVALID_MEASUREMENT')
      if (state.observations.some(row => row.farm_id === input.farm_id && row.crop_id === input.crop_id &&
          row.source === input.source && row.device_id === input.device_id &&
          Date.parse(row.observed_at) === Date.parse(input.observed_at))) {
        fail(409, 'Observasi dengan sumber dan waktu ini sudah tercatat.')
      }
      const result = { ...input, observation_id: createId('OBS'), status: 'accepted', recorded_at: now }
      state.observations.unshift(result)
      return save(result)
    }
    case '/harvest-estimates': {
      allow('FARMER')
      const input = body as EstimateInput
      amount(input.estimated_quantity_kg)
      const result = { ...input, estimate_id: createId('EST'), status: 'accepted', recorded_at: now }
      state.estimates.unshift(result)
      return save(result)
    }
    case '/harvest-predictions': {
      allow('COORDINATOR')
      const { data_reference_ids, ...input } = body as PredictionInput
      const matchFarm = (row: { farm_id: string; crop_id?: string }) =>
        row.farm_id === input.farm_id && (!row.crop_id || row.crop_id === input.crop_id)
      const matches = data_reference_ids.every(id =>
        state.observations.some(row => row.observation_id === id && matchFarm(row)) ||
        state.estimates.some(row => row.estimate_id === id && matchFarm(row) && row.harvest_period === input.target_period))
      if (!data_reference_ids.length || !matches) {
        fail(422, 'Referensi data tidak ditemukan untuk kebun dan komoditas ini.', 'PREDICTION_UNAVAILABLE')
      }
      const quantity = input.crop_id === 'SPINACH' ? 12.4 : 18.6
      const result = {
        ...input, prediction_id: createId('PRED'), predicted_quantity_kg: quantity, model_version: 'rf-demo-v1',
        source_of_training_data: 'synthetic', generated_at: now, status: 'generated', requires_coordinator_review: true,
      }
      state.predictions.unshift(result)
      return save(result)
    }
    case '/supply-risk-assessments': {
      allow('COORDINATOR')
      const input = body as RiskInput
      amount(input.planned_demand_kg)
      const { predicted_quantity_kg } = prediction(input.prediction_id)
      const shortage_gap_kg = Number(Math.max(0, input.planned_demand_kg - predicted_quantity_kg).toFixed(4))
      const result = {
        ...input, predicted_quantity_kg, shortage_gap_kg, assessed_at: now,
        status: shortage_gap_kg > 0 ? 'SHORTAGE_POSSIBLE' : 'NO_SHORTAGE_INDICATED',
      }
      state.risks = [result, ...state.risks.filter(row => row.prediction_id !== input.prediction_id)]
      return save(result)
    }
    case '/approved-availability': {
      allow('COORDINATOR')
      const input = body as ApprovalInput
      amount(input.approved_quantity_kg)
      const sameCrop = (row: { farm_id: string; crop_id: string }) =>
        row.farm_id === input.farm_id && row.crop_id === input.crop_id
      const basisExists = input.basis_type === 'PREDICTION'
        ? state.predictions.some(row => row.prediction_id === input.basis_id && sameCrop(row) && row.target_period === input.period)
        : state.estimates.some(row => row.estimate_id === input.basis_id && sameCrop(row) && row.harvest_period === input.period)
      if (!basisExists) fail(422, 'Referensi persetujuan tidak cocok dengan kebun, komoditas, atau periode.')
      if (state.approvals.some(row => sameCrop(row) && row.period === input.period)) {
        fail(409, 'Ketersediaan sudah disetujui. Gunakan penyesuaian alokasi untuk mengubah kuantitas.')
      }
      const result: Availability = {
        ...input, availability_id: createId('AVL'), status: 'APPROVED', version: 1, approved_by: 'COORD-001', approved_at: now,
      }
      state.approvals.unshift(result)
      return save(result)
    }
    case '/member-selections': {
      allow('MEMBER')
      if (!account.canSelect) fail(403, 'Paket ini tidak mencakup hak pilih.')
      const input = body as SelectionInput
      const used = input.items.reduce((sum, row) => sum + row.quantity_kg, 0)
      if (used <= 0 || used > 2 || new Set(input.items.map(row => row.availability_id)).size !== input.items.length) {
        fail(422, 'Paket Pilih memiliki kuota 2 kg per minggu.')
      }
      for (const row of input.items) {
        const a = approved(row.availability_id)
        if (a.period !== input.period || a.version !== row.availability_version) {
          fail(409, 'Ketersediaan sudah berubah. Muat ulang daftar sayuran.')
        }
        const reserved = state.selections.filter(selection => selection.member_id !== account.memberId)
          .flatMap(selection => selection.items)
          .reduce((sum, item) => sum + (item.availability_id === row.availability_id ? item.quantity_kg : 0), 0)
        if (!(row.quantity_kg > 0) || row.quantity_kg > a.approved_quantity_kg - reserved) {
          fail(422, 'Jumlah pilihan melebihi pasokan yang tersedia.')
        }
      }
      const result = { ...input, selection_id: createId('SEL'), member_id: account.memberId!, status: 'accepted', recorded_at: now }
      state.selections = [result, ...state.selections.filter(row => row.member_id !== account.memberId || row.period !== input.period)]
      return save(result)
    }
    case '/actual-harvests': {
      allow('COORDINATOR')
      const input = body as ActualInput
      amount(input.actual_quantity_kg)
      if (state.actuals.some(row => row.farm_id === input.farm_id && row.crop_id === input.crop_id && row.period === input.period)) {
        fail(409, 'Hasil panen kebun dan komoditas ini sudah tercatat untuk periode tersebut.')
      }
      const result = { ...input, actual_harvest_id: createId('ACT'), status: 'CONFIRMED', confirmed_by: 'COORD-001', recorded_at: now }
      state.actuals.unshift(result)
      return save(result)
    }
    case '/allocation-adjustments': {
      allow('COORDINATOR')
      const input = body as AllocationInput
      const a = approved(input.availability_id)
      amount(input.approved_quantity_kg)
      if (a.version !== input.expected_version) fail(409, 'Versi ketersediaan telah berubah. Muat ulang sebelum menyimpan.')
      if (input.actual_harvest_id && !state.actuals.some(row => row.actual_harvest_id === input.actual_harvest_id &&
          row.farm_id === a.farm_id && row.crop_id === a.crop_id && row.period === a.period)) {
        fail(422, 'ID panen aktual tidak cocok dengan ketersediaan.')
      }
      if (input.member_allocations.some(row => !Number.isFinite(row.quantity_kg) || row.quantity_kg < 0) ||
          input.member_allocations.reduce((sum, row) => sum + row.quantity_kg, 0) - input.approved_quantity_kg > 1e-9) {
        fail(422, 'Total alokasi melebihi kuantitas yang disetujui.')
      }
      const result = {
        ...input, adjustment_id: createId('ADJ'), version: a.version + 1, approved_by: 'COORD-001', approved_at: now,
      }
      state.adjustments.unshift(result)
      Object.assign(a, { version: result.version, approved_quantity_kg: result.approved_quantity_kg })
      return save(result)
    }
    case '/member-feedback': {
      allow('MEMBER')
      const input = body as FeedbackInput
      if (input.period !== demoPeriod) fail(422, 'Penerimaan paket belum tercatat untuk periode ini.')
      const result = { ...input, feedback_id: createId('FDB'), member_id: account.memberId!, status: 'accepted', recorded_at: now }
      state.feedback.unshift(result)
      return save(result)
    }
    default:
      return fail(404, 'Endpoint tidak ditemukan.')
  }
}
