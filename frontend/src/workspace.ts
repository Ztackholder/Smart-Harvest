import type { Api } from './api'
import type { Account, Estimate, Prediction } from './contracts'
import type { Activity } from './simulation'

export type Page = 'ringkasan' | 'prediksi' | 'ketersediaan' | 'panen' | 'observasi' | 'estimasi' | 'sayuran' | 'alokasi' | 'umpan-balik'

export type Workspace = {
  account: Account
  api: Api
  period: string
  activity: Activity
  revision: number
  refresh: () => void
  remember: <K extends keyof Activity>(key: K, row: Activity[K][number]) => void
  go: (page: Page) => void
  proposal?: Prediction | Estimate
  propose: (basis: Prediction | Estimate) => void
  openPrediction: (id?: string) => void
  predictionId?: string
}

export function latestPredictions(activity: Activity, period: string) {
  const rows = activity.predictions.filter(row => row.target_period === period)
    .sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at))
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = `${row.farm_id}:${row.crop_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
