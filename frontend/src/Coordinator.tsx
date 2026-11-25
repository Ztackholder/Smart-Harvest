import { useCallback, useEffect, useState } from 'react'
import { cropName, dateTime, isSimulation, kg, type Availability, type Prediction } from './contracts'
import { FarmCropFields } from './Farmer'
import { Button, Chip, CopyId, Empty, Field, Heading, HistoryShortcut, Notice, Panel, QueryMessage, isoDate, localDate, number, useAction, useQuery, value } from './ui'
import { latestPredictions, type Workspace } from './workspace'

function RiskForm({ prediction, work }: { prediction: Prediction; work: Workspace }) {
  const action = useAction()
  const risk = work.activity.risks.find(row => row.prediction_id === prediction.prediction_id)
  return <>
    {risk && <Notice tone={risk.shortage_gap_kg > 0 ? 'shortage' : 'good'}>
      {risk.shortage_gap_kg > 0 ? `Potensi kekurangan ${kg(risk.shortage_gap_kg)} kg.` : 'Prediksi mencukupi kebutuhan rencana.'}
      <br />Dinilai untuk kebutuhan {kg(risk.planned_demand_kg)} kg.
    </Notice>}
    <form className="form form-inline" onSubmit={action.submit(async data => {
      const result = await work.api.post('/supply-risk-assessments', {
        prediction_id: prediction.prediction_id, planned_demand_kg: number(data, 'demand'),
      })
      work.remember('risks', result)
    })}>
      <Field label="Kebutuhan rencana (kg)" name="demand" type="number" min={0} step="any" defaultValue={risk?.planned_demand_kg} required />
      <Button type="submit" variant="secondary" disabled={action.pending}>{action.pending ? 'Menilai…' : 'Nilai risiko'}</Button>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </form>
  </>
}

function PredictionDetail({ work, id, onOpen }: { work: Workspace; id?: string; onOpen: (id: string) => void }) {
  const load = useCallback(async () => id ? work.api.prediction(id) : undefined, [work.api, id])
  const query = useQuery(load)
  const action = useAction()
  const selected = query.data
  const { remember } = work
  useEffect(() => { if (selected) remember('predictions', selected) }, [remember, selected])
  return <Panel title="Tinjau prediksi" description={id ? undefined : 'Pilih prediksi tercatat atau buka dengan ID.'}>
    {id && <QueryMessage {...query} />}
    {selected && <>
      <div className="prediction-result">
        <div className="item-top"><strong>{cropName(selected.crop_id)}</strong><span>{selected.farm_id}, {selected.target_period}</span></div>
        <strong className="big-number">{kg(selected.predicted_quantity_kg)} <small>kg</small></strong>
      </div>
      <RiskForm key={id} work={work} prediction={selected} />
      <Button icon="arrow.right" onClick={() => work.propose(selected)}>Siapkan persetujuan</Button>
      <details className="prediction-metadata">
        <summary>Detail prediksi</summary>
        <dl className="details">
          <div><dt>Model</dt><dd>{selected.model_version}</dd></div>
          <div><dt>Data pelatihan</dt><dd>{/synthe|sinte/i.test(selected.source_of_training_data) ? 'Sintetis' : selected.source_of_training_data}</dd></div>
          <div><dt>Dibuat</dt><dd>{dateTime(selected.generated_at)}</dd></div>
        </dl>
      </details>
    </>}
    <form className="form form-inline" key={id} onSubmit={action.submit(async data => {
      const target = value(data, 'prediction_id')
      if (!target) throw new Error('Masukkan ID prediksi.')
      if (target === id) query.reload()
      else onOpen(target)
    })}>
      <Field label="ID prediksi" name="prediction_id" defaultValue={id} placeholder="PRED-001" required />
      <Button type="submit" variant="secondary">Buka</Button>
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </form>
  </Panel>
}

export function Predictions({ work }: { work: Workspace }) {
  const [showGenerate, setShowGenerate] = useState(false)
  const action = useAction()
  const rows = latestPredictions(work.activity, work.period)
  const sampleRefs = isSimulation && work.period === '2026-W46' ? 'OBS-001, EST-001' : ''
  return <div className="stack">
    <Heading title="Prediksi panen">
      <div className="heading-actions">
        <Button icon="plus" onClick={() => setShowGenerate(open => !open)} aria-expanded={showGenerate}
          aria-controls={showGenerate ? 'generate-prediction' : undefined}>{showGenerate ? 'Tutup formulir' : 'Buat prediksi'}</Button>
        {rows.length > 0 && <HistoryShortcut target="prediksi-tercatat">Lihat catatan</HistoryShortcut>}
      </div>
    </Heading>
    <div className="work-columns">
      <div className="stack">
        {showGenerate && <div id="generate-prediction"><Panel title="Buat prediksi">
          <form className="form" onSubmit={action.submit(async data => {
            const ids = [...new Set(value(data, 'references').split(/[,\s]+/).filter(Boolean))]
            if (!ids.length) throw new Error('Masukkan minimal satu ID data.')
            const result = await work.api.post('/harvest-predictions', {
              farm_id: value(data, 'farm_id'), crop_id: value(data, 'crop_id'), target_period: work.period, data_reference_ids: ids,
            })
            work.remember('predictions', result)
            work.openPrediction(result.prediction_id)
            setShowGenerate(false)
          })}>
            <FarmCropFields />
            <Field label="ID referensi data" name="references" defaultValue={sampleRefs} placeholder="OBS-001, EST-001"
              hint="Pisahkan ID observasi atau estimasi dengan koma." required />
            {action.error && <Notice tone="error">{action.error} <Button variant="text" onClick={() => work.go('ketersediaan')}>Gunakan estimasi petani</Button></Notice>}
            <Button type="submit" disabled={action.pending}>{action.pending ? 'Memproses…' : 'Jalankan prediksi'}</Button>
          </form>
        </Panel></div>}
        <PredictionDetail work={work} id={work.predictionId} onOpen={work.openPrediction} />
      </div>
      <Panel id="prediksi-tercatat" title="Prediksi tercatat">
        {rows.length ? <ul className="records">{rows.map(row => <li key={row.prediction_id}>
          <button type="button" className="record-button" onClick={() => work.openPrediction(row.prediction_id)}
            aria-pressed={row.prediction_id === work.predictionId}>
            <div className="item-top"><strong>{cropName(row.crop_id)}</strong><strong>{kg(row.predicted_quantity_kg)} kg</strong></div>
            <span>{row.farm_id}, {row.prediction_id}</span>
          </button>
        </li>)}</ul> : <Empty>Prediksi yang dibuat dalam sesi ini akan muncul di sini.</Empty>}
      </Panel>
    </div>
  </div>
}

function ApprovalForm({ work }: { work: Workspace }) {
  const action = useAction()
  const proposal = work.proposal
  const pred = proposal && 'prediction_id' in proposal ? proposal : undefined
  const est = proposal && 'estimate_id' in proposal ? proposal : undefined
  const [saved, setSaved] = useState<Availability>()

  return <form className="form" onSubmit={action.submit(async data => {
    setSaved(undefined)
    const result = await work.api.post('/approved-availability', {
      farm_id: value(data, 'farm_id'), crop_id: value(data, 'crop_id'), period: work.period,
      basis_type: value(data, 'basis_type') === 'PREDICTION' ? 'PREDICTION' : 'MANUAL_ESTIMATE',
      basis_id: value(data, 'basis_id'), approved_quantity_kg: number(data, 'quantity'), approval_note: value(data, 'note'),
    })
    work.remember('approvals', result)
    setSaved(result)
  })}>
    <FarmCropFields farm={proposal?.farm_id} crop={proposal?.crop_id} />
    <div className="form-grid">
      <Field label="Dasar persetujuan">
        <select name="basis_type" defaultValue={pred ? 'PREDICTION' : 'MANUAL_ESTIMATE'}>
          <option value="PREDICTION">Hasil prediksi</option>
          <option value="MANUAL_ESTIMATE">Estimasi petani</option>
        </select>
      </Field>
      <Field label="ID prediksi atau estimasi" name="basis_id" defaultValue={pred?.prediction_id ?? est?.estimate_id} placeholder="PRED-001" required />
    </div>
    <Field label="Kuantitas disetujui (kg)" type="number" name="quantity"
      defaultValue={pred?.predicted_quantity_kg ?? est?.estimated_quantity_kg} min={0} step="any" required />
    <Field label="Catatan persetujuan"><textarea name="note" required rows={3} /></Field>
    {action.error && <Notice tone="error">{action.error}</Notice>}
    {saved && <Notice tone="good">Ketersediaan dipublikasikan untuk {work.period}. <CopyId value={saved.availability_id} /></Notice>}
    <Button type="submit" disabled={action.pending} icon="checkmark">{action.pending ? 'Menerbitkan…' : 'Setujui dan publikasikan'}</Button>
  </form>
}

function AdjustForm({ work, item, onSaved, reload }: { work: Workspace; item?: Availability; onSaved: () => void; reload: () => void }) {
  const action = useAction()
  const [members, setMembers] = useState<number[]>([])
  const [nextMember, setNextMember] = useState(1)
  const [saved, setSaved] = useState('')
  const actual = item && work.activity.actuals.find(row => row.farm_id === item.farm_id &&
    row.crop_id === item.crop_id && row.period === item.period)
  return <form className="form" onSubmit={action.submit(async data => {
    setSaved('')
    const quantity = number(data, 'quantity')
    const member_allocations = members.map(key => ({ member_id: value(data, `member_${key}`), quantity_kg: number(data, `amount_${key}`) }))
    if (new Set(member_allocations.map(row => row.member_id)).size !== member_allocations.length) {
      throw new Error('Gunakan satu baris per anggota.')
    }
    if (member_allocations.reduce((sum, row) => sum + row.quantity_kg, 0) - quantity > 1e-9) {
      throw new Error('Total alokasi anggota melebihi kuantitas yang disetujui.')
    }
    const result = await work.api.post('/allocation-adjustments', {
      availability_id: value(data, 'availability_id'), expected_version: number(data, 'version'),
      approved_quantity_kg: quantity, reason: value(data, 'reason'), actual_harvest_id: value(data, 'actual') || undefined,
      member_allocations,
    })
    onSaved()
    setSaved(`Penyesuaian ${result.adjustment_id} tersimpan. Versi baru ${result.version}.`)
  })}>
    <div className="form-grid">
      <Field label="ID ketersediaan" name="availability_id" defaultValue={item?.availability_id} required />
      <Field label="Versi saat ini" key={item?.version} name="version" type="number" min={1} step={1} defaultValue={item?.version} required />
    </div>
    <div className="form-grid">
      <Field label="Kuantitas baru (kg)" name="quantity" type="number" min={0} step="any" defaultValue={item?.approved_quantity_kg} required />
      <Field label="ID panen aktual (opsional)" name="actual" defaultValue={actual?.actual_harvest_id} />
    </div>
    <Field label="Alasan penyesuaian"><textarea name="reason" rows={3} required /></Field>
    <fieldset className="measurement-fields">
      <legend>Alokasi per anggota</legend>
      {members.map((key, i) => <div key={key} className="allocation-fields">
        <div className="form-grid">
          <Field label={`ID anggota ${i + 1}`} name={`member_${key}`} defaultValue={isSimulation && i === 0 ? 'MBR-001' : undefined} required />
          <Field label="Kuantitas (kg)" name={`amount_${key}`} type="number" min={0} step="any" required />
        </div>
        <Button variant="text" onClick={() => setMembers(rows => rows.filter(row => row !== key))}>Hapus anggota {i + 1}</Button>
      </div>)}
      <Button variant="secondary" icon="plus" onClick={() => { setMembers(rows => [...rows, nextMember]); setNextMember(nextMember + 1) }}>
        Tambah anggota
      </Button>
    </fieldset>
    {action.error && <Notice tone="error">{action.error} {action.status === 409 && <Button variant="text" onClick={reload}>Muat ulang</Button>}</Notice>}
    {saved && <Notice tone="good">{saved}</Notice>}
    <Button type="submit" disabled={action.pending}>{action.pending ? 'Menyimpan…' : 'Simpan penyesuaian'}</Button>
  </form>
}

export function Coordination({ work }: { work: Workspace }) {
  const [mode, setMode] = useState<'publish' | 'adjust'>('publish')
  const [activeItem, setActiveItem] = useState<Availability>()
  const load = useCallback(() => { void work.revision; return work.api.availability(work.period) }, [work.api, work.period, work.revision])
  const rows = useQuery(load)
  const approvals = rows.data?.items.filter(row => row.status === 'APPROVED') ?? work.activity.approvals.filter(row => row.period === work.period)
  const current = approvals.find(row => row.availability_id === activeItem?.availability_id) ?? activeItem
  return <div className="stack">
    <Heading title="Ketersediaan" />
    <div className="work-columns">
      <Panel title={mode === 'publish' ? 'Publikasi ke anggota' : 'Penyesuaian alokasi'}>
        <div className="segmented" role="group" aria-label="Tindakan ketersediaan">
          <Button variant="text" aria-pressed={mode === 'publish'} onClick={() => setMode('publish')}>Persetujuan</Button>
          <Button variant="text" aria-pressed={mode === 'adjust'} onClick={() => setMode('adjust')}>Penyesuaian</Button>
        </div>
        {mode === 'publish' ? <ApprovalForm key={work.proposal ? ('prediction_id' in work.proposal ? work.proposal.prediction_id : work.proposal.estimate_id) : 'manual'} work={work} /> :
          <AdjustForm key={activeItem?.availability_id ?? 'manual'} work={work} item={current}
            onSaved={work.refresh} reload={() => { rows.reload(); setActiveItem(undefined) }} />}
      </Panel>
      <div className="stack">
        <Panel title="Ketersediaan resmi">
          <QueryMessage {...rows} />
          {approvals.length ? <ul className="records">{approvals.map(row => <li key={row.availability_id}>
            <div className="item-top"><strong>{cropName(row.crop_id)}</strong><Chip tone="good">Disetujui v{row.version}</Chip></div>
            <p><strong>{kg(row.approved_quantity_kg)} kg</strong> dari {row.farm_id}</p>
            {row.approved_by && row.approved_at && <p>{row.approved_by}, {dateTime(row.approved_at)}</p>}
            <div className="item-top"><CopyId value={row.availability_id} />
              <Button variant="text" onClick={() => { setActiveItem(row); setMode('adjust') }}>Sesuaikan</Button>
            </div>
          </li>)}</ul> : !rows.loading && !rows.error && <Empty>Belum ada ketersediaan yang dipublikasikan.</Empty>}
        </Panel>
        {mode === 'publish' && work.activity.estimates.some(row => row.harvest_period === work.period) && <Panel title="Estimasi petani">
          <ul className="records">{work.activity.estimates.filter(row => row.harvest_period === work.period).map(row => <li key={row.estimate_id}>
            <div className="item-top"><strong>{cropName(row.crop_id)}</strong><strong>{kg(row.estimated_quantity_kg)} kg</strong></div>
            <div className="item-top"><CopyId value={row.estimate_id} /><Button variant="text" onClick={() => work.propose(row)}>Gunakan</Button></div>
          </li>)}</ul>
        </Panel>}
      </div>
    </div>
  </div>
}

export function ActualHarvest({ work }: { work: Workspace }) {
  const action = useAction()
  const [saved, setSaved] = useState('')
  const rows = work.activity.actuals.filter(row => row.period === work.period)
  return <div className="stack">
    <Heading title="Panen aktual" description="Catat hasil panen terkonfirmasi sebelum sortir." />
    <div className="work-columns">
      <Panel title="Catat hasil aktual">
        <form className="form" onSubmit={action.submit(async data => {
          setSaved('')
          const result = await work.api.post('/actual-harvests', {
            farm_id: value(data, 'farm_id'), crop_id: value(data, 'crop_id'), period: work.period,
            actual_quantity_kg: number(data, 'quantity'), harvested_at: isoDate(data, 'harvested_at'),
            source: 'manual', confirmation_note: value(data, 'note'),
          })
          work.remember('actuals', result)
          setSaved(result.actual_harvest_id)
        })}>
          <FarmCropFields />
          <div className="form-grid">
            <Field label="Hasil aktual (kg)" name="quantity" type="number" min={0} step="any" required />
            <Field label="Waktu panen" name="harvested_at" type="datetime-local" defaultValue={localDate()} required />
          </div>
          <Field label="Catatan konfirmasi"><textarea name="note" rows={3} required /></Field>
          {action.error && <Notice tone="error">{action.error}</Notice>}
          {saved && <Notice tone="good">Panen dikonfirmasi. <CopyId value={saved} /></Notice>}
          <Button type="submit" disabled={action.pending}>{action.pending ? 'Menyimpan…' : 'Konfirmasi hasil panen'}</Button>
        </form>
      </Panel>
      <Panel title="Hasil terkonfirmasi">
        {rows.length ? <ul className="records">{rows.map(row => {
          const pred = latestPredictions(work.activity, work.period).find(prediction =>
            prediction.farm_id === row.farm_id && prediction.crop_id === row.crop_id)
          const est = work.activity.estimates.find(estimate =>
            estimate.harvest_period === work.period && estimate.farm_id === row.farm_id && estimate.crop_id === row.crop_id)
          return <li key={row.actual_harvest_id}>
            <div className="item-top"><strong>{cropName(row.crop_id)}</strong><strong>{kg(row.actual_quantity_kg)} kg</strong></div>
            <p>{row.farm_id}, {dateTime(row.harvested_at)}</p>
            {est && <p>Estimasi petani {kg(est.estimated_quantity_kg)} kg</p>}
            {pred && <p>Prediksi {kg(pred.predicted_quantity_kg)} kg</p>}
            <CopyId value={row.actual_harvest_id} />
          </li>
        })}</ul> : <Empty>Belum ada hasil aktual yang dicatat untuk periode ini.</Empty>}
      </Panel>
    </div>
  </div>
}
