export type CoordinatorRecords = {
  hasFarmData: boolean
  hasEstimate: boolean
  hasPrediction: boolean
  predictionUnavailable?: boolean
  hasRiskOrPlan: boolean
  planStale?: boolean
  hasAvailability: boolean
  approvedBasisType?: 'PREDICTION' | 'MANUAL_ESTIMATE'
  hasActual: boolean
  actualBelowAllocation?: boolean
  allocationAdjustedAfterActual?: boolean
  allReceiptsConfirmed?: boolean
  hasFeedback?: boolean
}

export type CoordinatorAction = 'rencana' | 'kebun' | 'alokasi-realisasi' | 'riwayat-evaluasi'

export type CoordinatorStep = {
  key:
    | 'waiting-data'
    | 'awaiting-prediction'
    | 'review-plan'
    | 'publish-availability'
    | 'record-actual'
    | 'adjust-allocation'
    | 'confirm-receipts'
    | 'operational-complete'
    | 'complete'
  label: string
  reason: string
  action?: CoordinatorAction
}

export function nextCoordinatorStep(records: CoordinatorRecords): CoordinatorStep {
  if (!records.hasAvailability) {
    if (!records.hasFarmData && !records.hasPrediction) {
      return {
        key: 'waiting-data',
        label: 'Menunggu data kebun',
        reason: 'Belum ada estimasi petani atau observasi untuk periode ini.',
        action: 'kebun',
      }
    }
    if (!records.hasPrediction) {
      if (records.hasEstimate) {
        return {
          key: 'publish-availability',
          label: 'Tinjau estimasi manual',
          reason: records.predictionUnavailable
            ? 'Prediksi AI tidak tersedia; gunakan estimasi petani.'
            : 'Estimasi tersedia; jalankan prediksi atau gunakan dasar manual.',
          action: 'rencana',
        }
      }
      return {
        key: 'awaiting-prediction',
        label: 'Hitung prediksi',
        reason: 'Data kebun tersedia, prediksi belum dibuat.',
        action: 'kebun',
      }
    }
    if (!records.hasRiskOrPlan || records.planStale) {
      return {
        key: 'review-plan',
        label: 'Tinjau rencana pasokan',
        reason: records.planStale
          ? 'Prediksi berubah setelah tinjauan terakhir.'
          : 'Masukkan kebutuhan rencana sebelum menyetujui ketersediaan.',
        action: 'rencana',
      }
    }
    return {
      key: 'publish-availability',
      label: 'Setujui ketersediaan',
      reason: 'Rencana sudah ditinjau dan siap dipublikasikan ke anggota.',
      action: 'rencana',
    }
  }

  // After approval (whether PREDICTION or MANUAL_ESTIMATE), never loop back to prediction
  if (!records.hasActual) {
    return {
      key: 'record-actual',
      label: 'Catat panen aktual',
      reason: 'Ketersediaan sudah dipublikasikan; catat hasil panen terkonfirmasi.',
      action: 'alokasi-realisasi',
    }
  }
  if (records.actualBelowAllocation && !records.allocationAdjustedAfterActual) {
    return {
      key: 'adjust-allocation',
      label: 'Sesuaikan alokasi',
      reason: 'Hasil panen aktual lebih rendah dari alokasi anggota.',
      action: 'alokasi-realisasi',
    }
  }
  if (records.allReceiptsConfirmed === false) {
    return {
      key: 'confirm-receipts',
      label: 'Konfirmasi penerimaan paket',
      reason: 'Konfirmasi paket diterima agar anggota dapat mengirim umpan balik.',
      action: 'alokasi-realisasi',
    }
  }
  if (records.hasFeedback === false) {
    return {
      key: 'operational-complete',
      label: 'Operasional selesai',
      reason: 'Menunggu umpan balik opsional dari anggota.',
      action: 'riwayat-evaluasi',
    }
  }
  return {
    key: 'complete',
    label: 'Siklus selesai',
    reason: 'Seluruh tahap layanan dan umpan balik telah tercatat.',
    action: 'riwayat-evaluasi',
  }
}
