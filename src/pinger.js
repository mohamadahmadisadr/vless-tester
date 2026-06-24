const CORS_PROXY = 'https://corsproxy.io/?url='
const GITHUB_URL = 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt'

export function parseVless(raw) {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'vless:') return null
    const p = u.searchParams
    const host = u.hostname
    const port = u.port || '443'
    const sni = p.get('sni') || host
    const hostHeader = p.get('host') || sni
    const transport = p.get('type') || 'tcp'
    const security = p.get('security') || 'none'
    const path = p.get('path') || '/'
    const tag = decodeURIComponent(u.hash.replace('#', '')) || `${host}:${port}`
    return { raw: raw.trim(), host, port, sni, hostHeader, path, security, transport, tag }
  } catch {
    return null
  }
}

export async function fetchConfigs() {
  const res = await fetch(CORS_PROXY + encodeURIComponent(GITHUB_URL))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return text
    .split('\n')
    .map(l => parseVless(l))
    .filter(Boolean)
}

async function fetchProbe(url, timeoutMs) {
  const start = performance.now()
  try {
    await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    return Math.round(performance.now() - start)
  } catch {
    return null
  }
}

function imageProbe(base, timeoutMs) {
  return new Promise(resolve => {
    const img = new Image()
    const start = performance.now()
    const t = setTimeout(() => { img.src = ''; resolve(null) }, timeoutMs)
    img.onload = img.onerror = () => {
      clearTimeout(t)
      resolve(Math.round(performance.now() - start))
    }
    img.src = `${base}/favicon.ico?_=${Date.now()}`
  })
}

export async function pingConfig(cfg, timeoutMs = 5000) {
  const transport = cfg.transport.toLowerCase()
  const useTLS = cfg.security === 'tls' || cfg.security === 'reality'
  const scheme = useTLS ? 'https' : 'http'

  if (['xhttp', 'http', 'ws', 'h2', 'splithttp'].includes(transport)) {
    const url = `${scheme}://${cfg.hostHeader}:${cfg.port}${cfg.path}`
    return fetchProbe(url, timeoutMs)
  }

  return imageProbe(`${scheme}://${cfg.host}:${cfg.port}`, timeoutMs)
}

export async function pingAll({ configs, concurrency = 30, timeoutMs = 5000, maxWorking = 5, onResult, signal }) {
  const queue = [...configs]
  let workingCount = 0

  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.aborted || workingCount >= maxWorking) break
      const cfg = queue.shift()
      if (!cfg) break
      const ms = await pingConfig(cfg, timeoutMs)
      if (signal?.aborted) break
      const result = { ...cfg, pingMs: ms, reachable: ms !== null }
      if (ms !== null) workingCount++
      onResult?.(result)
      if (workingCount >= maxWorking) break
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, configs.length) }, worker)
  )
}
