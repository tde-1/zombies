// Pure helpers for the launcher 0.2.11 UI (update chip, Download, installed maps). No
// imports, so web/test/run-all.js can load this file under plain Node and pin the words
// and the numbers the player sees.

// What the nav chip shows for an update status (launcher/src/main/updatecheck.js): null
// (nothing), 'available', 'downloading', 'ready' or 'failed' (a download that broke:
// Retry). A failed launch-time CHECK draws nothing: there is no update to offer, and the
// Settings box already says why. "Later" hides every phase until the next launch.
export function chipPhase(u) {
  if (!u || u.later) return null
  if (u.phase === 'ready' && u.canInstall !== false) return 'ready'
  if (u.phase === 'downloading') return 'downloading'
  if (u.phase === 'available' && u.available) return 'available'
  if ((u.phase === 'failed' || u.phase === 'unreachable') && u.available) return 'failed'
  return null
}

export const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))

// GB with one decimal, MB under 1 GB (B: "how many gigabytes it is"). Binary units, which
// is what Windows Explorer calls GB, so the number matches the folder's Properties.
const GB = 1024 ** 3
const MB = 1024 ** 2
export function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  if (n >= MB) return `${Math.max(1, Math.round(n / MB))} MB`
  return `${Math.max(0, Math.round(n / 1024))} KB`
}

// Installed maps, largest first (B: "Sort by size"). The launcher already sends them in
// this order; the page sorts again so the rule lives on this side too.
export const bySizeDesc = (list) => [...(list || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0) || String(a.bsp).localeCompare(String(b.bsp)))
