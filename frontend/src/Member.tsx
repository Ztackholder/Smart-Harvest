import { useCallback, useState } from 'react'
import { cropName, dateTime, isSimulation, kg, periodDates, type Availability, type Selection } from './contracts'
import { Button, Chip, CopyId, Empty, Field, Heading, Notice, Panel, QueryMessage, number, useAction, useQuery, value } from './ui'
import type { Workspace } from './workspace'

function SelectionForm({ work, rows, reload }: { work: Workspace; rows: Availability[]; reload: () => void }) {
  const action = useAction()
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Selection>()
  const total = rows.reduce((sum, row) => sum + (Number(amounts[row.availability_id]) || 0), 0)
  const quota = isSimulation ? 2 : undefined
  const excess = quota === undefined ? 0 : total - quota
  const quotaMessage = quota === undefined || excess <= 0 ? '' : excess < 0.01
    ? `Kurangi pilihan agar total paling banyak ${kg(quota)} kg.`
    : `Kurangi pilihan sebanyak ${kg(excess)} kg.`
  return <form className="form" onSubmit={action.submit(async data => {
    setSaved(undefined)
    const items = rows.flatMap(row => {
      const quantity_kg = number(data, row.availability_id)
      return quantity_kg > 0 ? [{ availability_id: row.availability_id, availability_version: row.version, quantity_kg }] : []
    })
    if (!items.length) throw new Error('Masukkan berat untuk setidaknya satu sayuran.')
    if (quotaMessage) throw new Error(quotaMessage)
    setSaved(await work.api.post('/member-selections', { period: work.period, items }))
  })}>
    <ul className="records member-produce">
      {rows.map(row => <li key={row.availability_id}>
        <div><h3>{cropName(row.crop_id)}</h3><p>{kg(row.approved_quantity_kg)} kg tersedia dari {row.farm_id}</p></div>
        <Field label={`Pilihan ${cropName(row.crop_id)} (kg)`} name={row.availability_id} type="number" min={0}
          max={row.approved_quantity_kg} step="any" placeholder="0" disabled={action.pending}
          value={amounts[row.availability_id] ?? ''} onChange={event => {
            setSaved(undefined)
            setAmounts(current => ({ ...current, [row.availability_id]: event.target.value }))
          }} />
      </li>)}
    </ul>
    <div className="selection-total"><span>Total pilihan</span><strong>{kg(total)} {quota !== undefined && `/ ${kg(quota)}`} kg</strong></div>
    {action.error && <Notice tone="error">{action.error}
      {action.status === 409 && <Button variant="text" onClick={reload}>Muat ulang ketersediaan</Button>}
    </Notice>}
    {saved && <Notice tone="good">Pilihan tersimpan. <CopyId value={saved.selection_id} /></Notice>}
    {quotaMessage && <Notice tone="warn">{quotaMessage}</Notice>}
    <Button type="submit" disabled={action.pending || total <= 0 || Boolean(quotaMessage)}>
      {action.pending ? 'Mengirim…' : 'Kirim pilihan'}
    </Button>
  </form>
}

export function MemberAvailability({ work }: { work: Workspace }) {
  const load = useCallback(() => work.api.availability(work.period), [work.api, work.period])
  const response = useQuery(load)
  const rows = response.data?.items.filter(item => item.status === 'APPROVED')
  return <div className="stack member-sheet">
    <Heading title="Sayuran tersedia" description={periodDates(work.period)}>
      <Chip tone={work.account.canSelect ? 'good' : 'neutral'}>{work.account.canSelect ? 'Paket Pilih' : 'Paket reguler'}</Chip>
    </Heading>
    <Panel title="Ketersediaan resmi"
      description={work.account.canSelect ? undefined : 'Alokasi Paket Reguler ditetapkan oleh koordinator.'}>
      <QueryMessage {...response} />
      {rows && (rows.length ? work.account.canSelect ?
        <SelectionForm work={work} rows={rows} reload={response.reload} /> :
        <ul className="records">{rows.map(row => <li key={row.availability_id}>
          <div className="item-top"><strong>{cropName(row.crop_id)}</strong><strong>{kg(row.approved_quantity_kg)} kg</strong></div>
          <p>{row.farm_id}</p>
        </li>)}</ul> : <Empty>Koordinator belum memublikasikan sayuran untuk periode ini.</Empty>)}
    </Panel>
  </div>
}

export function MemberUpdates({ work }: { work: Workspace }) {
  const load = useCallback(() => work.api.updates(work.period), [work.api, work.period])
  const response = useQuery(load)
  return <div className="stack member-sheet">
    <Heading title="Pembaruan alokasi" description={periodDates(work.period)} />
    <div className="stack member-updates">
      {response.status === 404 || response.status === 501
        ? <Notice>Pembaruan alokasi belum tersedia. <Button variant="text" onClick={response.reload}>Coba lagi</Button></Notice>
        : <QueryMessage {...response} />}
      {response.data && (response.data.items.length ? <ul className="records">{response.data.items.map(row =>
        <li key={row.adjustment_id}>
          <div className="item-top"><strong>{row.crop_id ? cropName(row.crop_id) : row.availability_id}</strong><strong>{kg(row.quantity_kg)} kg</strong></div>
          <p>{row.reason}</p><p>Versi {row.version}, {dateTime(row.approved_at)}</p>
        </li>)}</ul> : <Empty>Belum ada perubahan alokasi untuk paketmu.</Empty>)}
    </div>
  </div>
}

export function MemberFeedback({ work }: { work: Workspace }) {
  const action = useAction()
  const [saved, setSaved] = useState('')
  return <div className="stack member-sheet">
    <Heading title="Umpan balik" description="Kirim setelah paket sayuran diterima." />
    <form className="form" onSubmit={action.submit(async data => {
      setSaved('')
      const comment = value(data, 'comment')
      if (!comment) throw new Error('Tuliskan umpan balik sebelum mengirim.')
      const result = await work.api.post('/member-feedback', { period: work.period, comment })
      setSaved(result.feedback_id)
    })}>
      <Field label="Komentar tentang paket"><textarea name="comment" rows={5} required maxLength={2000} /></Field>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {saved && <Notice tone="good">Umpan balik terkirim. <CopyId value={saved} /></Notice>}
      <Button type="submit" disabled={action.pending}>{action.pending ? 'Mengirim…' : 'Kirim umpan balik'}</Button>
    </form>
  </div>
}
