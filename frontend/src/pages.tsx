import { ActualHarvest, Coordination, Predictions } from './Coordinator'
import { Dashboard } from './Dashboard'
import { Estimates, Observations } from './Farmer'
import { MemberAvailability, MemberFeedback, MemberUpdates } from './Member'
import type { Page, Workspace } from './workspace'

const views = {
  ringkasan: Dashboard,
  prediksi: Predictions,
  ketersediaan: Coordination,
  panen: ActualHarvest,
  observasi: Observations,
  estimasi: Estimates,
  sayuran: MemberAvailability,
  alokasi: MemberUpdates,
  'umpan-balik': MemberFeedback,
}

export function WorkspacePage({ page, work }: { page: Page; work: Workspace }) {
  const View = views[page]
  return <View work={work} />
}
