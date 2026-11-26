import type { Api } from './api'
import type { Account, Catalog } from './contracts'

export type Page =
  | 'ringkasan'
  | 'kebun'
  | 'detail-kebun'
  | 'rencana'
  | 'pemantauan'
  | 'alokasi-realisasi'
  | 'riwayat-evaluasi'
  | 'kebun-saya'
  | 'estimasi'
  | 'riwayat-petani'
  | 'paket-saya'
  | 'pilihan'
  | 'pembaruan'
  | 'riwayat-anggota'

export const emptyCatalog: Catalog = { farms: [], crops: [], periods: [], members: [] }

export type FarmFocus = { farmId: string; cropId: string }

export type Workspace = {
  account: Account
  api: Api
  period: string
  catalog: Catalog
  revision: number
  refresh: () => void
  go: (page: Page, focus?: FarmFocus) => void
  focus?: FarmFocus
  onAuthExpired: () => void
}
