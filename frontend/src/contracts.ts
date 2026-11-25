export type Role = 'FARMER' | 'COORDINATOR' | 'MEMBER'
export type Account = {
  role: Role
  name: string
  memberId?: string
  canSelect?: boolean
  token?: string
}

export const accounts: Account[] = [
  { role: 'COORDINATOR', name: 'Koordinator' },
  { role: 'FARMER', name: 'Petani mitra' },
  { role: 'MEMBER', name: 'Anggota CSA', memberId: 'MBR-001', canSelect: true },
  { role: 'MEMBER', name: 'Anggota CSA', memberId: 'MBR-002', canSelect: false },
]

export const apiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '')
export const isSimulation = !apiBase
export const demoPeriod = '2026-W46'
export const periodPattern = '[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])'
const configuredPeriod = import.meta.env.VITE_DEFAULT_PERIOD?.trim()
export const initialPeriod = isValidPeriod(configuredPeriod) ? configuredPeriod : isSimulation ? demoPeriod : currentPeriod()
export const defaultFarm = 'FARM-01'
export const defaultCrop = 'SPINACH'

const cropNames: Record<string, string> = {
  SPINACH: 'Bayam', PAKCHOY: 'Pakcoy', PAKCOY: 'Pakcoy', AMARANTH: 'Bayam',
  KANGKUNG: 'Kangkung', LETTUCE: 'Selada',
}

export const cropName = (id: string) => cropNames[id] ?? id
export const kg = (amount: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(amount)
export const dateTime = (date: string) => new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta',
}).format(new Date(date)) + ' WIB'

export function currentPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date)
  const part = (type: 'year' | 'month' | 'day') => Number(parts.find(item => item.type === type)?.value)
  const thursday = new Date(Date.UTC(part('year'), part('month') - 1, part('day')))
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7))
  const year = thursday.getUTCFullYear()
  const week = Math.ceil(((+thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function isValidPeriod(period?: string): period is string {
  if (!period || !new RegExp(`^${periodPattern}$`).test(period)) return false
  const [year, week] = period.split('-W').map(Number)
  const lastWeek = currentPeriod(new Date(Date.UTC(year, 11, 28)))
  return year >= 1900 && week <= Number(lastWeek.slice(-2))
}

function periodStart(period: string) {
  const [year, week] = period.split('-W').map(Number)
  const monday = new Date(Date.UTC(year, 0, 4))
  monday.setUTCDate(4 - (monday.getUTCDay() + 6) % 7 + (week - 1) * 7)
  return monday
}

export function shiftPeriod(period: string, weeks: number) {
  const monday = periodStart(period)
  monday.setUTCDate(monday.getUTCDate() + weeks * 7)
  return currentPeriod(monday)
}

export function periodDates(period: string) {
  const monday = periodStart(period)
  const sunday = new Date(+monday + 6 * 86_400_000)
  if (Number.isNaN(+monday)) return period
  const separator = monday.getUTCMonth() === sunday.getUTCMonth() ? '-' : ' - '
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).formatRange(monday, sunday).replace(/\s*[-\u2013\u2014]\s*/, separator)
}

export type FarmCrop = { farm_id: string; crop_id: string }
export type Measurement = { type: string; value: number; unit: string }
export type ObservationInput = {
  farm_id: string
  crop_id?: string
  device_id?: string
  observed_at: string
  source: 'manual' | 'csv' | 'simulated_iot' | 'iot'
  measurements: Measurement[]
}
export type Observation = ObservationInput & {
  observation_id: string
  status: string
  recorded_at: string
}
export type EstimateInput = FarmCrop & { harvest_period: string; estimated_quantity_kg: number; recorded_at: string }
export type Estimate = EstimateInput & { estimate_id: string; status: string }
export type PredictionInput = FarmCrop & { target_period: string; data_reference_ids: string[] }
export type Prediction = Omit<PredictionInput, 'data_reference_ids'> & {
  prediction_id: string
  predicted_quantity_kg: number
  model_version: string
  source_of_training_data: string
  generated_at: string
  status: string
  requires_coordinator_review: boolean
}
export type RiskInput = { prediction_id: string; planned_demand_kg: number }
export type Risk = RiskInput & {
  predicted_quantity_kg: number
  shortage_gap_kg: number
  status: string
  assessed_at: string
}
export type ApprovalInput = FarmCrop & {
  period: string
  basis_type: 'PREDICTION' | 'MANUAL_ESTIMATE'
  basis_id: string
  approved_quantity_kg: number
  approval_note: string
}
export type Availability = ApprovalInput & {
  availability_id: string
  status: 'APPROVED'
  version: number
  approved_by: string
  approved_at: string
}
export type SelectionInput = {
  period: string
  items: { availability_id: string; availability_version: number; quantity_kg: number }[]
}
export type Selection = SelectionInput & { selection_id: string; member_id: string; status: string; recorded_at: string }
export type AllocationInput = {
  availability_id: string
  expected_version: number
  approved_quantity_kg: number
  reason: string
  actual_harvest_id?: string
  member_allocations: { member_id: string; quantity_kg: number }[]
}
export type Allocation = AllocationInput & { adjustment_id: string; version: number; approved_by: string; approved_at: string }
export type AllocationUpdate = FarmCrop & {
  adjustment_id: string; availability_id: string; quantity_kg: number; reason: string; version: number; approved_at: string
}
export type ActualInput = FarmCrop & {
  period: string; actual_quantity_kg: number; harvested_at: string; source: string; confirmation_note: string
}
export type Actual = ActualInput & { actual_harvest_id: string; status: string; confirmed_by: string; recorded_at: string }
export type FeedbackInput = { period: string; comment: string }
export type Feedback = FeedbackInput & { feedback_id: string; member_id: string; status: string; recorded_at: string }
export type Items<T> = { items: T[] }

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}
