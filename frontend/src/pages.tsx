import { AllocationRealization, FarmDetail, FarmsDirectory, HarvestPlan, HistoryEvaluation } from './Coordinator'
import { Dashboard } from './Dashboard'
import { FarmerEstimates, FarmerHistory, FarmerHome } from './Farmer'
import { MemberHistoryFeedback, MemberHome, MemberSelectionCatalog, MemberUpdates } from './Member'
import { Monitoring } from './Monitoring'
import type { Page, Workspace } from './workspace'

export function WorkspacePage({ page, work }: { page: Page; work: Workspace }) {
  switch (page) {
    case 'ringkasan': return <Dashboard work={work} />
    case 'kebun': return <FarmsDirectory work={work} />
    case 'detail-kebun': return <FarmDetail work={work} />
    case 'rencana': return <HarvestPlan work={work} />
    case 'pemantauan': return <Monitoring work={work} />
    case 'alokasi-realisasi': return <AllocationRealization work={work} />
    case 'riwayat-evaluasi': return <HistoryEvaluation work={work} />
    case 'kebun-saya': return <FarmerHome work={work} />
    case 'estimasi': return <FarmerEstimates work={work} />
    case 'riwayat-petani': return <FarmerHistory work={work} />
    case 'paket-saya': return <MemberHome work={work} />
    case 'pilihan': return <MemberSelectionCatalog work={work} />
    case 'pembaruan': return <MemberUpdates work={work} />
    case 'riwayat-anggota': return <MemberHistoryFeedback work={work} />
  }
}
