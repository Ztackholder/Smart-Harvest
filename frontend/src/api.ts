import type {
  Account, Actual, ActualInput, Allocation, AllocationInput, AllocationUpdate, ApprovalInput, Availability,
  Estimate, EstimateInput, Feedback, FeedbackInput, Items, Observation, ObservationInput, Prediction,
  PredictionInput, Risk, RiskInput, Selection, SelectionInput,
} from './contracts'
import { apiBase, ApiError } from './contracts'
import { simulate } from './simulation'

type Operations = {
  '/farm-observations': [ObservationInput, Observation]
  '/harvest-estimates': [EstimateInput, Estimate]
  '/harvest-predictions': [PredictionInput, Prediction]
  '/supply-risk-assessments': [RiskInput, Risk]
  '/approved-availability': [ApprovalInput, Availability]
  '/member-selections': [SelectionInput, Selection]
  '/allocation-adjustments': [AllocationInput, Allocation]
  '/actual-harvests': [ActualInput, Actual]
  '/member-feedback': [FeedbackInput, Feedback]
}

function errorMessage(status: number, payload: unknown) {
  const data = payload as { error?: { code?: string; message?: string }; detail?: unknown } | null
  if (data?.error?.message) return data.error.message
  if (typeof data?.detail === 'string') return data.detail
  if (Array.isArray(data?.detail)) {
    return data.detail.map((field: { loc?: string[]; msg?: string }) =>
      [field.loc?.slice(1).join('.'), field.msg].filter(Boolean).join(': ')).join('. ')
  }
  const defaults: Record<number, string> = {
    401: 'Token tidak valid atau sudah kedaluwarsa. Perbarui token melalui menu akun.',
    403: 'Akun ini tidak memiliki izin untuk tindakan tersebut.',
    404: 'Data atau endpoint tidak ditemukan.',
    409: 'Data sudah berubah. Muat ulang sebelum mencoba lagi.',
    422: 'Sebagian data tidak valid. Periksa isian formulir.',
  }
  return defaults[status] ?? `Permintaan gagal (HTTP ${status}).`
}

export function createApi(account: Account) {
  async function request<T>(path: string, body?: unknown) {
    if (!apiBase) return simulate(account, path, body) as T
    let response: Response
    try {
      response = await fetch(apiBase + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(account.token && { Authorization: `Bearer ${account.token}` }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new ApiError(
        0,
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Batas waktu permintaan tercapai. Periksa hasil sebelum mengirim ulang.'
          : 'API tidak dapat dihubungi. Periksa koneksi dan alamat server.',
      )
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, errorMessage(response.status, payload), payload?.error?.code)
    if (payload === null) throw new ApiError(response.status, 'Server tidak mengembalikan respons JSON yang valid.')
    return payload as T
  }

  return {
    post<P extends keyof Operations>(path: P, body: Operations[P][0]) {
      return request<Operations[P][1]>(path, body)
    },
    prediction(id: string) {
      return request<Prediction>(`/harvest-predictions/${encodeURIComponent(id)}`)
    },
    availability(period: string) {
      return request<Items<Availability>>(`/approved-availability?${new URLSearchParams({ period })}`)
    },
    updates(period: string) {
      return request<Items<AllocationUpdate>>(`/allocation-updates?${new URLSearchParams({ period })}`)
    },
  }
}

export type Api = ReturnType<typeof createApi>
