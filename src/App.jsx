import { useState, useRef, useCallback } from 'react'
import { fetchConfigs, pingAll } from './pinger'
import './App.css'

const MAX_WORKING = 5
const CONCURRENCY = 20
const TIMEOUT_MS = 7000

function pingColor(ms) {
  if (ms <= 300) return 'fast'
  if (ms <= 700) return 'mid'
  return 'slow'
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handle = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }
  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handle}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function ConfigCard({ result }) {
  const color = pingColor(result.pingMs)
  return (
    <div className="config-card">
      <div className={`ping-badge ping-${color}`}>{result.pingMs} ms</div>
      <div className="config-info">
        <div className="config-tag">{result.tag}</div>
        <div className="config-host">{result.host}:{result.port} · {result.transport}</div>
      </div>
      <CopyButton text={result.raw} />
    </div>
  )
}

export default function App() {
  const [status, setStatus] = useState('idle')
  const [results, setResults] = useState([])
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const testedRef = useRef(0)
  const totalRef = useRef(0)

  const handleResult = useCallback((result) => {
    testedRef.current += 1
    setProgress(Math.min(100, Math.round(testedRef.current / totalRef.current * 100)))
    if (result.reachable) {
      setResults(prev => [...prev, result].sort((a, b) => a.pingMs - b.pingMs))
    }
  }, [])

  const start = async () => {
    setResults([])
    setError(null)
    setProgress(0)
    testedRef.current = 0
    totalRef.current = 0
    setStatus('fetching')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const configs = await fetchConfigs()
      if (controller.signal.aborted) return
      totalRef.current = configs.length
      setStatus('testing')

      await pingAll({
        configs,
        concurrency: CONCURRENCY,
        timeoutMs: TIMEOUT_MS,
        maxWorking: MAX_WORKING,
        onResult: handleResult,
        signal: controller.signal,
      })

      setStatus(controller.signal.aborted ? 'idle' : 'done')
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e.message)
        setStatus('idle')
      }
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setStatus('idle')
  }

  const clear = () => {
    abortRef.current?.abort()
    setResults([])
    setProgress(0)
    setError(null)
    testedRef.current = 0
    totalRef.current = 0
    setStatus('idle')
  }

  const isRunning = status === 'fetching' || status === 'testing'
  const hasResults = results.length > 0

  return (
    <div className="app">

      {/* Top bar — only visible after first run */}
      {(hasResults || isRunning || status === 'done') && (
        <div className="topbar">
          <span className="topbar-title">VLESS Tester</span>
          <div className="topbar-actions">
            {isRunning
              ? <button className="btn-ghost" onClick={stop}>Stop</button>
              : <>
                <button className="btn-ghost" onClick={clear}>Clear</button>
                <button className="btn-ghost" onClick={start}>Redo</button>
              </>
            }
          </div>
        </div>
      )}

      <div className={`main ${hasResults || isRunning ? 'main-top' : 'main-center'}`}>

        {/* Hero — only when idle and no results */}
        {!hasResults && !isRunning && status !== 'done' && (
          <div className="hero">
            <div className="hero-icon">
              <ShieldIcon />
            </div>
            <h1>VLESS Tester</h1>
            <p>Finds working configs on your connection</p>
            {error && <div className="error">{error}</div>}
            <button className="btn-start" onClick={start}>
              Start testing
            </button>
          </div>
        )}

        {/* Progress bar */}
        {isRunning && (
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="progress-label">
              {status === 'fetching' ? 'Fetching configs…' : `${progress}%`}
            </div>
          </div>
        )}

        {/* Results */}
        {hasResults && (
          <div className="results">
            {results.map((r, i) => <ConfigCard key={i} result={r} />)}
          </div>
        )}

        {/* Done, no results */}
        {status === 'done' && !hasResults && (
          <div className="empty">
            No working configs found
            <button className="btn-ghost" onClick={start} style={{ marginTop: 16 }}>Try again</button>
          </div>
        )}

        {/* Redo button below results when done */}
        {status === 'done' && hasResults && (
          <div className="done-row">
            <span className="done-label">Done · {results.length} found</span>
          </div>
        )}

      </div>
    </div>
  )
}

function ShieldIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}