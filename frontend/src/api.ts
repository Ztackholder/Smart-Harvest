import type {
  Account,
  Actual,
  ActualInput,
  Allocation,
  AllocationInput,
  AllocationUpdate,
  ApprovalInput,
  Availability,
  Catalog,
  CommodityPlan,
  CommodityPlanInput,
  CoordinatorOverview,
  Estimate,
  EstimateInput,
  FarmerOverview,
  Feedback,
  FeedbackInput,
  Items,
  MemberOverview,
  Observation,
  ObservationInput,
  Prediction,
  PredictionInput,
  Receipt,
  ReceiptInput,
  Risk,
  RiskInput,
  Selection,
  SelectionInput,
  SmartApplyInput,
  SmartPlanResult,
  TelemetryHistory,
  TelemetrySummary,
} from './contracts'
import { apiBase, ApiError } from './contracts'
import { simulate } from './simulation'

type Operations = {
  '/farm-observations': [ObservationInput, Observation]
  '/harvest-estimates': [EstimateInput, Estimate]
  '/harvest-predictions': [PredictionInput, Prediction]
  '/supply-risk-assessments': [RiskInput, Risk]
  '/commodity-plans': [CommodityPlanInput, CommodityPlan]
  '/approved-availability': [ApprovalInput, Availability]
  '/member-selections': [SelectionInput, Selection]
  '/allocation-adjustments': [AllocationInput, Allocation]
  '/actual-harvests': [ActualInput, Actual]
  '/member-feedback': [FeedbackInput, Feedback]
  '/package-receipts': [ReceiptInput, Receipt]
  '/member/subscription': [
    { period: string; target_package: 'Paket Reguler' | 'Paket Custom' },
    { effective_period: string; package_name: string; eligible: boolean; quota_kg: number },
  ]
  '/allocations/smart-plan': [{ period: string }, SmartPlanResult]
  '/allocations/apply': [SmartApplyInput, { period: string; applied_count: number; adjustments: Allocation[] }]
}

function errorMessage(status: number, payload: unknown) {
  const data = payload as { error?: { code?: string; message?: string }; detail?: unknown } | null
  if (data?.error?.message) {
    if (/Farm is not assigned/i.test(data.error.message)) return 'Anda tidak memiliki akses ke kebun ini.'
    return data.error.message
  }
  if (typeof data?.detail === 'string') return data.detail
  if (Array.isArray(data?.detail)) {
    return data.detail
      .map((field: { loc?: string[]; msg?: string }) => [field.loc?.slice(1).join('.'), field.msg].filter(Boolean).join(': '))
      .join('. ')
  }
  const defaults: Record<number, string> = {
    401: 'Sesi berakhir atau kredensial tidak valid. Silakan masuk kembali.',
    403: 'Akun ini tidak memiliki izin untuk tindakan tersebut.',
    404: 'Data tidak ditemukan.',
    409: 'Data sudah berubah atau tercatat. Muat ulang sebelum mencoba lagi.',
    422: 'Sebagian data tidak valid. Periksa isian formulir.',
    503: 'Model prediksi sementara tidak tersedia. Gunakan estimasi petani sebagai dasar manual.',
  }
  return defaults[status] ?? `Permintaan gagal (HTTP ${status}).`
}

export type AuthProfile = {
  user_id: string
  username: string
  role: Account['role']
  name: string
  farm_ids: string[]
  member_id: string | null
  can_select: boolean
}
type AuthResult = { user: AuthProfile; csrf_token: string }

function accountFromAuth(result: AuthResult): Account {
  return {
    userId: result.user.user_id,
    username: result.user.username,
    role: result.user.role,
    name: result.user.name,
    farmIds: result.user.farm_ids,
    memberId: result.user.member_id ?? undefined,
    canSelect: result.user.can_select,
    csrfToken: result.csrf_token,
  }
}

async function authRequest<T>(path: string, body?: unknown, csrfToken?: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ApiError(0, 'API tidak dapat dihubungi. Periksa koneksi dan alamat server.')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, errorMessage(response.status, payload), payload?.error?.code)
  return payload as T
}

export async function signIn(username: string, password: string): Promise<Account> {
  return accountFromAuth(await authRequest<AuthResult>('/auth/login', { username, password }))
}

export async function restoreSession(): Promise<Account> {
  return accountFromAuth(await authRequest<AuthResult>('/auth/me'))
}

export async function signOut(csrfToken: string) {
  return authRequest<{ status: string }>('/auth/logout', {}, csrfToken)
}

export async function updatePassword(current_password: string, new_password: string, csrfToken: string) {
  return authRequest<{ status: string; signed_out: boolean }>('/auth/password', { current_password, new_password }, csrfToken)
}

export function createApi(account: Account) {
  const getCache = new Map<string, { expiresAt: number; data: unknown }>()
  const cacheablePrefixes = ['/catalog', '/coordinator/overview', '/farmer/overview', '/member/overview']

  async function request<T>(path: string, body?: unknown, signal?: AbortSignal) {
    if (!apiBase) return simulate(account, path, body) as T
    const isGet = body === undefined
    const canCache = isGet && cacheablePrefixes.some(prefix => path.startsWith(prefix))
    if (canCache) {
      const hit = getCache.get(path)
      if (hit && Date.now() < hit.expiresAt) return hit.data as T
    }
    if (!isGet) getCache.clear()
    let response: Response
    try {
      response = await fetch(apiBase + path, {
        method: isGet ? 'GET' : 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body !== undefined && account.csrfToken && { 'X-CSRF-Token': account.csrfToken }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(15_000),
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
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
    if (canCache) getCache.set(path, { expiresAt: Date.now() + 15_000, data: payload })
    if (!isGet) getCache.clear()
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
    observations(farm_id: string, limit = 100, offset = 0, source?: string) {
      const params = new URLSearchParams({ farm_id, limit: String(limit), offset: String(offset) })
      if (source && source !== 'all') params.set('source', source)
      return request<Items<Observation>>(`/farm-observations?${params}`)
    },
    estimates(farm_id: string, period: string) {
      return request<Items<Estimate>>(`/harvest-estimates?${new URLSearchParams({ farm_id, period })}`)
    },
    predictions(farm_id: string, period: string) {
      return request<Items<Prediction>>(`/harvest-predictions?${new URLSearchParams({ farm_id, period })}`)
    },
    risks(period: string) {
      return request<Items<Risk>>(`/supply-risk-assessments?${new URLSearchParams({ period })}`)
    },
    actuals(farm_id: string, period: string) {
      return request<Items<Actual>>(`/actual-harvests?${new URLSearchParams({ farm_id, period })}`)
    },
    catalog() {
      return request<Catalog>('/catalog')
    },
    selections(period: string) {
      return request<Items<Selection>>(`/member-selections?${new URLSearchParams({ period })}`)
    },
    telemetrySummary(farm_id: string, signal?: AbortSignal) {
      return request<TelemetrySummary>(`/telemetry/summary?${new URLSearchParams({ farm_id })}`, undefined, signal)
    },
    telemetryHistory(farm_id: string, range: '1h' | '24h' | '7d', source = 'all', signal?: AbortSignal) {
      return request<TelemetryHistory>(
        `/telemetry/history?${new URLSearchParams({ farm_id, range, source })}`,
        undefined,
        signal,
      )
    },
    coordinatorOverview(period: string, signal?: AbortSignal) {
      return request<CoordinatorOverview>(`/coordinator/overview?${new URLSearchParams({ period })}`, undefined, signal)
    },
    farmerOverview(period: string, signal?: AbortSignal) {
      return request<FarmerOverview>(`/farmer/overview?${new URLSearchParams({ period })}`, undefined, signal)
    },
    memberOverview(period: string, signal?: AbortSignal) {
      return request<MemberOverview>(`/member/overview?${new URLSearchParams({ period })}`, undefined, signal)
    },
  }
}

export type Api = ReturnType<typeof createApi>
