const GITHUB_URL =
  'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt'

export async function fetchConfigs() {
  const res = await fetch(GITHUB_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return text
    .split('\n')
    .map(l => parseVless(l))
    .filter(Boolean)
}

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
    const tag =
      decodeURIComponent(u.hash.replace('#', '')) || `${host}:${port}`
    return { raw: raw.trim(), host, port, sni, hostHeader, path, security, transport, tag }
  } catch {
    return null
  }
}

// Only imageProbe is reliable from https:// pages.
// fetch() with mode:'no-cors' returns an opaque response (status 0)
// even when the host is dead — giving fake 0ms results.
// imageProbe requires a real TCP connection for any response at all.
function imageProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const img = new Image()
    const start = performance.now()

    const timer = setTimeout(() => {
      img.onload = img.onerror = null
      img.src = ''
      resolve(null) // true timeout = unreachable
    }, timeoutMs)

    img.onload = img.onerror = () => {
      clearTimeout(timer)
      // Both load and error mean the host responded at TCP level.
      // "error" just means no valid image — the connection was real.
      resolve(Math.round(performance.now() - start))
    }

    // Always https — avoids mixed content block on https pages.
    // Even http-only servers respond to the TLS attempt fast enough
    // to confirm reachability.
    img.src = `https://${host}:${port}/favicon.ico?_=${Date.now()}`
  })
}

export async function pingConfig(cfg, timeoutMs = 5000) {
  return imageProbe(cfg.host, cfg.port, timeoutMs)
}

export async function pingAll({
  configs,
  concurrency = 30,
  timeoutMs = 5000,
  maxWorking = 5,
  onResult,
  signal,
}) {
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