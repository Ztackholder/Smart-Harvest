import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'
import {
  ArrowRight, ArrowUpRight, CalendarDays, ChartLine, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleUserRound,
  ClipboardList, FileText, LayoutGrid, Leaf, MessageSquare, Package, Plus, Radio, RefreshCw, ShoppingBasket, TriangleAlert,
} from 'lucide-react'
import { ApiError } from './contracts'

const webSymbols = {
  'square.grid.2x2': LayoutGrid,
  'chart.line.uptrend.xyaxis': ChartLine,
  basket: ShoppingBasket,
  shippingbox: Package,
  leaf: Leaf,
  'list.bullet.clipboard': ClipboardList,
  'bubble.left': MessageSquare,
  'arrow.triangle.2.circlepath': RefreshCw,
  calendar: CalendarDays,
  'chevron.down': ChevronDown,
  'chevron.left': ChevronLeft,
  'chevron.right': ChevronRight,
  'arrow.up.right': ArrowUpRight,
  'arrow.right': ArrowRight,
  plus: Plus,
  'exclamationmark.triangle': TriangleAlert,
  'checkmark.circle': CircleCheck,
  'antenna.radiowaves.left.and.right': Radio,
  'person.crop.circle': CircleUserRound,
  'doc.text': FileText,
  checkmark: Check,
}

export type SymbolName = keyof typeof webSymbols
declare global {
  interface Window { smartHarvestSymbols?: Partial<Record<SymbolName, string>> }
}

export function Symbol({ name }: { name: SymbolName }) {
  const candidate = window.smartHarvestSymbols?.[name]
  const nativeUrl = typeof candidate === 'string' && candidate.startsWith('data:image/png;base64,') ? candidate : undefined
  const [loadedUrl, setLoadedUrl] = useState<string>()
  useEffect(() => {
    if (!nativeUrl || !globalThis.CSS?.supports?.('mask-image', 'url("")')) return
    const image = new Image()
    image.onload = () => setLoadedUrl(nativeUrl)
    image.src = nativeUrl
    return () => { image.onload = null }
  }, [nativeUrl])

  if (nativeUrl && loadedUrl === nativeUrl) {
    return <span aria-hidden="true" className="symbol symbol--native" style={{ maskImage: `url("${nativeUrl}")` }} />
  }
  const WebIcon = webSymbols[name]
  return <WebIcon aria-hidden="true" focusable="false" className="symbol" strokeWidth={1.75} />
}

export function Button({ icon, variant = 'primary', className = '', children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { icon?: SymbolName; variant?: 'primary' | 'secondary' | 'text' }) {
  return <button type="button" {...props} className={`button button--${variant} ${className}`}>
    {icon && <Symbol name={icon} />}{children}
  </button>
}

export function Heading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-heading">
    <div><h1 tabIndex={-1}>{title}</h1>{description && <p>{description}</p>}</div>
    {children}
  </div>
}

export function Panel({ id, title, description, children, actions, className = '' }: {
  id?: string; title: string; description?: string; children: ReactNode; actions?: ReactNode; className?: string
}) {
  const headingId = useId()
  return <section id={id} className={`panel ${className}`} aria-labelledby={headingId}>
    <header className="panel-heading"><div><h2 id={headingId} tabIndex={id ? -1 : undefined}>{title}</h2>{description && <p>{description}</p>}</div>{actions}</header>
    {children}
  </section>
}

export function HistoryShortcut({ target, children }: { target: string; children: ReactNode }) {
  return <Button className="history-shortcut" variant="text" onClick={() => {
    const heading = document.getElementById(target)?.querySelector('h2')
    heading?.focus({ preventScroll: true })
    heading?.scrollIntoView({ block: 'start' })
  }}>{children}</Button>
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' }) {
  return <span className={`chip chip--${tone}`}>{children}</span>
}

export function Notice({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'shortage' | 'error' }) {
  return <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {tone === 'good' && <Symbol name="checkmark.circle" />}
    {(tone === 'error' || tone === 'warn' || tone === 'shortage') && <Symbol name="exclamationmark.triangle" />}
    <div>{children}</div>
  </div>
}

export function Field({ label, hint, children, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: string; hint?: string; children?: ReactNode
}) {
  const labelId = useId()
  const hintId = useId()
  const inputMode = props.inputMode ?? (props.type === 'number' ? (props.step === 'any' ? 'decimal' : 'numeric') : undefined)
  return <label className="field">
    <span id={labelId}>{label}</span>
    {children ?? <input {...props} inputMode={inputMode} aria-labelledby={labelId} aria-describedby={hint ? hintId : props['aria-describedby']} />}
    {hint && <small id={hintId}>{hint}</small>}
  </label>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export function CopyId({ value }: { value: string }) {
  const [result, setResult] = useState<'copied' | 'failed'>()
  useEffect(() => {
    if (result !== 'copied') return
    const timeout = setTimeout(() => setResult(undefined), 1800)
    return () => clearTimeout(timeout)
  }, [result])
  return <span className="copy-control">
    <span className="copy-value">{value}</span>
    <button className="copy-id" type="button" aria-label={'Salin ' + value} onClick={async () => {
      try {
        await navigator.clipboard.writeText(value)
        setResult('copied')
      } catch {
        setResult('failed')
      }
    }}>{result === 'copied' ? 'Disalin' : 'Salin'}</button>
    <span className={result === 'failed' ? 'copy-error' : 'sr-only'} role="status">
      {result === 'copied' && 'ID disalin.'}
      {result === 'failed' && 'Pilih teks ID untuk menyalin manual.'}
    </span>
  </span>
}

export function useAction() {
  const busy = useRef(false)
  const [state, setState] = useState<{ pending: boolean; error?: string; status?: number }>({ pending: false })
  return {
    ...state,
    submit(fn: (data: FormData) => Promise<void>) {
      return async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (busy.current) return
        const data = new FormData(event.currentTarget)
        busy.current = true
        setState({ pending: true })
        try {
          await fn(data)
          setState({ pending: false })
        } catch (error) {
          setState({ pending: false, error: error instanceof Error ? error.message : 'Terjadi gangguan. Coba lagi.',
            status: error instanceof ApiError ? error.status : undefined })
        } finally {
          busy.current = false
        }
      }
    },
  }
}

export function useQuery<T>(load: () => Promise<T>) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ load: typeof load; revision: number; value?: T; error?: string; status?: number }>()
  useEffect(() => {
    let active = true
    load().then(
      value => { if (active) setResult({ load, revision, value }) },
      error => { if (active) setResult({ load, revision, error: error instanceof Error ? error.message : String(error),
        status: error instanceof ApiError ? error.status : undefined }) },
    )
    return () => { active = false }
  }, [load, revision])
  const current = result?.load === load && result.revision === revision ? result : undefined
  return {
    data: current?.value,
    error: current?.error,
    status: current?.status,
    loading: !current,
    reload: () => setRevision(value => value + 1),
  }
}

export function QueryMessage({ loading, error, reload }: { loading: boolean; error?: string; reload: () => void }) {
  if (loading) return <p className="empty" role="status">Memuat data…</p>
  return error ? <Notice tone="error">{error} <Button variant="text" onClick={reload}>Coba lagi</Button></Notice> : null
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current!
    const focused = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
    }
  }, [])
  return <dialog ref={ref} className="modal" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="modal-body">
      <header className="modal-heading"><h2 id={id}>{title}</h2><Button variant="text" onClick={onClose}>Tutup</Button></header>
      {children}
    </div>
  </dialog>
}

export const value = (data: FormData, field: string) => String(data.get(field) ?? '').trim()
export const number = (data: FormData, field: string) => Number(value(data, field))
export const localDate = () => {
  const now = new Date()
  return new Date(+now - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
export const isoDate = (data: FormData, field: string) => new Date(value(data, field)).toISOString()
