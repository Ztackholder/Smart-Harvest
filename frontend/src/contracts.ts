export type Role = 'FARMER' | 'COORDINATOR' | 'MEMBER'
export type Account = {
  role: Role
  name: string
  memberId?: string
  canSelect?: boolean
  farmIds?: string[]
  userId?: string
  username?: string
  csrfToken?: string
}

export const accounts: Account[] = [
  { role: 'COORDINATOR', name: 'Adriel Suherman' },
  { role: 'FARMER', name: 'Faiz Santoso' },
  { role: 'MEMBER', name: 'Nisrina Pratiwi', memberId: 'MBR-001', canSelect: true },
  { role: 'MEMBER', name: 'Adrian Hidayat', memberId: 'MBR-002', canSelect: false },
]

export const apiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '')
export const isSimulation = !apiBase
export const demoPeriod = '2026-W48'
export const periodPattern = '[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])'
const configuredPeriod = import.meta.env.VITE_DEFAULT_PERIOD?.trim()
export const initialPeriod = isValidPeriod(configuredPeriod) ? configuredPeriod : isSimulation ? demoPeriod : currentPeriod()
export const defaultFarm = 'FARM-01'
export const defaultCrop = 'SPINACH'

const cropNames: Record<string, string> = {
  SPINACH: 'Bayam',
  PAKCHOY: 'Pakcoy',
  PAKCOY: 'Pakcoy',
  AMARANTH: 'Bayam',
  KANGKUNG: 'Kangkung',
  LETTUCE: 'Selada hijau',
  MUSTARD_GREENS: 'Sawi hijau',
}

// Strict mapping per ASSET-CREDITS.md (unmapped crops fall back to neutral icon)
const cropImages: Record<string, string> = {
  SPINACH: 'images/sayuran/01-bayam.png',
  KANGKUNG: 'images/sayuran/02-kangkung.png',
  PAKCHOY: 'images/sayuran/03-pakcoy.png',
  PAKCOY: 'images/sayuran/03-pakcoy.png',
  LETTUCE: 'images/sayuran/04-selada-hijau.png',
  MUSTARD_GREENS: 'images/sayuran/05-sawi-hijau.png',
}

export const cropName = (id: string) => cropNames[id] ?? id
export const cropImage = (id: string) => {
  const rel = cropImages[id]
  return rel ? `${import.meta.env.BASE_URL}${rel}` : undefined
}
export const kg = (amount: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(amount)
export const dateTime = (date: string) =>
  new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(date)) + ' WIB'

export const shortDate = (date: string) =>
  new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(date))

export const relativeTime = (isoDateStr?: string | null) => {
  if (!isoDateStr) return 'Belum tersedia'
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(isoDateStr)) / 1000))
  if (diffSec < 60) return `${diffSec} detik lalu`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} menit lalu`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} jam lalu`
  return `${Math.floor(diffHr / 24)} hari lalu`
}

export function currentPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
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
  monday.setUTCDate(4 - ((monday.getUTCDay() + 6) % 7) + (week - 1) * 7)
  return monday
}

export function shiftPeriod(period: string, weeks: number) {
  const monday = periodStart(period)
  monday.setUTCDate(monday.getUTCDate() + weeks * 7)
  return currentPeriod(monday)
}

export function periodDates(period: string, shortMonth = false) {
  const monday = periodStart(period)
  const sunday = new Date(+monday + 6 * 86_400_000)
  if (Number.isNaN(+monday)) return period
  const separator = monday.getUTCMonth() === sunday.getUTCMonth() ? '–' : ' – '
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: shortMonth ? 'short' : 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .formatRange(monday, sunday)
    .replace(/\s*[-\u2013\u2014]\s*/, separator)
}

export function weekLabel(period: string) {
  const match = period.match(/W(\d{2})$/)
  return match ? `Minggu ${Number(match[1])}` : period
}

export type FarmCrop = { farm_id: string; crop_id: string }
export type CatalogFarm = { farm_id: string; name: string; farmer_name?: string; contact_phone?: string | null; synthetic?: boolean }
export type CatalogCrop = { crop_id: string; name: string; supported_by_model?: boolean }
export type CatalogMember = { member_id: string; name?: string; package_name?: string; eligible: boolean; quota_kg?: number }
export type Catalog = {
  farms: CatalogFarm[]
  crops: CatalogCrop[]
  periods: string[]
  members: CatalogMember[]
}
export type PlantingContext = FarmCrop & {
  planting_id?: string
  planting_date: string
  target_harvest_date: string
  planted_area_m2: number
  plant_count: number
  synthetic?: boolean
}
export type Measurement = { type: string; value: number; unit: string }
export type ObservationInput = {
  farm_id: string
  crop_id?: string
  device_id?: string
  observed_at: string
  source: 'manual' | 'csv' | 'simulated_iot' | 'iot' | 'external'
  measurements: Measurement[]
  provenance?: string
}
export type Observation = ObservationInput & {
  observation_id: string
  status: string
  recorded_at: string
}
export type EstimateInput = FarmCrop & { harvest_period: string; estimated_quantity_kg: number; recorded_at: string }
export type Estimate = EstimateInput & { estimate_id: string; status: string }
export type PredictionInput = FarmCrop & { target_period: string; data_reference_ids?: string[]; planting_id?: string }
export type ChannelCoverage = {
  valid_slots: number
  expected_slots: number
  coverage: number
  last_seen_hours: number | null
  usable: boolean
}
export type Prediction = Omit<PredictionInput, 'data_reference_ids'> & {
  prediction_id: string
  predicted_quantity_kg: number
  model_version: string
  source_of_training_data: string
  inference_route?: string
  feature_provenance?: string[]
  input_snapshot?: {
    planting_id?: string
    window_start: string
    window_end: string
    observation_count: number
    sources: string[]
    missing_features: string[]
    coverage: {
      air_temperature: ChannelCoverage
      relative_humidity: ChannelCoverage
      soil_moisture: ChannelCoverage
    }
  }
  trigger?: string
  generated_at: string
  status: string
  requires_coordinator_review: boolean
}
export type PredictionState = {
  farm_id: string
  crop_id: string
  period: string
  status: 'pending' | 'ready' | 'stale' | 'unavailable' | 'error'
  reason?: string | null
  stale_reason?: string | null
  latest_prediction_id?: string | null
  predicted_quantity_kg?: number | null
  inference_route?: string | null
  last_attempt_at?: string | null
  last_success_at?: string | null
  input_snapshot?: Prediction['input_snapshot']
}
export type RiskInput = { prediction_id: string; planned_demand_kg: number }
export type Risk = RiskInput & {
  assessment_id?: string
  predicted_quantity_kg: number
  shortage_gap_kg: number
  status: string
  assessed_at: string
}
export type CommodityPlanInput = {
  crop_id: string
  period: string
  planned_demand_kg: number
  review_note?: string
  verified_with_farmer?: boolean
  review_outcome?: 'CONFIRMED' | 'NEEDS_ADJUSTMENT' | 'WAITING_FARMER'
  farmer_verification_status?: 'UNCONFIRMED' | 'WAITING' | 'CONFIRMED'
  items?: { farm_id: string; basis_type: 'PREDICTION' | 'MANUAL_ESTIMATE'; basis_id: string }[]
}
export type CommodityPlan = {
  plan_id: string
  crop_id: string
  period: string
  plan_version: number
  planned_demand_kg: number
  total_supply_kg: number
  shortage_gap_kg: number
  status: 'SHORTAGE_POSSIBLE' | 'NO_SHORTAGE_INDICATED'
  coverage_status: 'complete_ai' | 'manual_fallback' | 'mixed' | 'incomplete'
  items: { farm_id: string; basis_type: 'PREDICTION' | 'MANUAL_ESTIMATE'; basis_id: string; quantity_kg: number }[]
  review_note: string
  verified_with_farmer: boolean
  review_outcome?: 'CONFIRMED' | 'NEEDS_ADJUSTMENT' | 'WAITING_FARMER'
  farmer_verification_status?: 'UNCONFIRMED' | 'WAITING' | 'CONFIRMED'
  is_stale: boolean
  reviewed_by: string
  reviewed_at: string
}
export type ApprovalInput = FarmCrop & {
  period: string
  basis_type: 'PREDICTION' | 'MANUAL_ESTIMATE'
  basis_id: string
  approved_quantity_kg: number
  approval_note: string
  assessment_id?: string
  commodity_plan_id?: string
}
export type Availability = {
  availability_id: string
  farm_id: string
  crop_id: string
  period: string
  approved_quantity_kg: number
  remaining_quantity_kg?: number
  initial_approved_quantity_kg?: number
  own_allocation_kg?: number
  basis_type?: 'PREDICTION' | 'MANUAL_ESTIMATE'
  basis_id?: string
  approval_note?: string
  status: 'APPROVED'
  version: number
  approved_by?: string
  approved_at: string
  member_allocations?: { member_id: string; quantity_kg: number }[]
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
  adjustment_id: string
  availability_id: string
  quantity_kg: number
  previous_quantity_kg?: number | null
  removed?: boolean
  reason: string
  version: number
  approved_at: string
}
export type ActualInput = FarmCrop & {
  period: string
  actual_quantity_kg: number
  harvested_at: string
  source: string
  confirmation_note: string
}
export type Actual = ActualInput & { actual_harvest_id: string; status: string; confirmed_by: string; recorded_at: string }
export type FeedbackInput = { period: string; comment: string }
export type Feedback = FeedbackInput & { feedback_id: string; member_id: string; status: string; recorded_at: string }
export type ReceiptInput = { member_id: string; period: string; confirmed: boolean }
export type Receipt = { receipt_id: string; member_id: string; period: string; received: boolean; confirmed_by: string; confirmed_at: string }
export type TelemetrySummary = {
  farm_id?: string
  status: 'online' | 'stale' | 'offline' | 'unknown'
  device_id: string | null
  source: Observation['source'] | null
  provenance: string | null
  last_observed_at: string | null
  last_received_at: string | null
  age_seconds: number | null
  configured_interval_seconds?: number | null
  observed_interval_seconds?: number | null
  inference_ready?: boolean
  readings: {
    air_temperature: number | null
    relative_humidity: number | null
    soil_moisture_index: number | null
    pressure: number | null
    soil_raw: number | null
  }
  sparklines?: {
    air_temperature: number[]
    relative_humidity: number[]
    soil_moisture_index: number[]
    pressure: number[]
  }
  coverage: {
    air_temperature: ChannelCoverage
    relative_humidity: ChannelCoverage
    soil_moisture_index: ChannelCoverage
  }
  observation_count_7d: number
}
export type TelemetryHistory = {
  farm_id: string
  range: '1h' | '24h' | '7d'
  bucket_seconds: number
  window_start: string
  window_end: string
  series: {
    timestamp: string
    air_temperature: number | null
    relative_humidity: number | null
    soil_moisture_index: number | null
    pressure: number | null
    soil_raw: number | null
  }[]
}
export type CoordinatorPlantingCard = {
  planting: PlantingContext
  farm: CatalogFarm
  crop: CatalogCrop
  latest_estimate: Estimate | null
  latest_prediction: Prediction | null
  prediction_history: Prediction[]
  prediction_state: PredictionState | null
  approval: Availability | null
  actual_harvest: Actual | null
  telemetry: TelemetrySummary
}
export type CoordinatorFarmGroup = {
  farm: CatalogFarm
  telemetry: TelemetrySummary
  plantings: CoordinatorPlantingCard[]
}
export type CoordinatorMemberRow = {
  member_id: string
  name: string
  initials: string
  package_name: string
  eligible: boolean
  quota_kg: number
  requested_items: { availability_id: string; crop_id: string | null; farm_id: string | null; quantity_kg: number }[]
  requested_total_kg: number | null
  allocated_items: { availability_id: string; crop_id: string; farm_id: string; quantity_kg: number }[]
  allocated_total_kg: number | null
  receipt_confirmed: boolean
  feedback_submitted: boolean
  lifecycle_status: 'Diterima' | 'Siap didistribusikan' | 'Perlu penyesuaian' | 'Menunggu alokasi' | 'Belum memilih'
}
export type CoordinatorOverview = {
  period: string
  available_periods?: string[]
  demo_mode?: boolean
  farms?: CoordinatorFarmGroup[]
  plantings: CoordinatorPlantingCard[]
  commodity_plans: CommodityPlan[]
  risks: Risk[]
  approvals: Availability[]
  selections: Selection[]
  adjustments: Allocation[]
  receipts: Receipt[]
  feedback: Feedback[]
  members: CatalogMember[]
  member_rows?: CoordinatorMemberRow[]
}
export type FarmerOverview = {
  period: string
  available_periods?: string[]
  demo_mode?: boolean
  farms?: { farm: CatalogFarm; telemetry: TelemetrySummary; plantings: FarmerOverview['plantings'] }[]
  plantings: {
    planting: PlantingContext
    farm: CatalogFarm
    crop: CatalogCrop
    latest_estimate: Estimate | null
    estimates: Estimate[]
    latest_prediction: Prediction | null
    telemetry: TelemetrySummary
  }[]
  recent_observations: Observation[]
}
export type MemberPackageCard = {
  period: string
  package_name: string
  status_label: string
  requested_items: { crop_id: string; quantity_kg: number }[]
  allocated_items: { crop_id: string; quantity_kg: number }[]
  total_kg: number
  receipt_confirmed: boolean
  received_at: string | null
  feedback: { feedback_id: string; comment: string; recorded_at: string } | null
}
export type MemberOverview = {
  period: string
  available_periods?: string[]
  demo_mode?: boolean
  progress_step?: 'waiting_publication' | 'published' | 'selected' | 'allocated' | 'received' | 'feedback_sent'
  member: {
    member_id: string
    name: string
    package_name: string
    eligible: boolean
    quota_kg: number
  }
  next_period_subscription?: {
    effective_period: string
    package_name: string
    eligible: boolean
    quota_kg: number
    updated_at?: string
  } | null
  availability: Availability[]
  selection: Selection | null
  updates: AllocationUpdate[]
  receipt: Receipt | null
  feedback: Feedback | null
  packages?: MemberPackageCard[]
  history: {
    selections: Selection[]
    feedback: Feedback[]
  }
}
export type Items<T> = { items: T[] }

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}
