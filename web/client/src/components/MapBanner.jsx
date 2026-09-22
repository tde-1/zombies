import { useState } from 'react'
// COPIED FROM MOVEMENT, `movement-client/src/components/MapBanner.jsx`, unchanged. Here the
// "mirror" is our /media/maps art; a map with none gets the hue wash.
//

// Renders a map's banner from the GOnext image mirror, stepping DOWN through what it has: the
// 768px thumb, then the full-size original, then a generated wash keyed on the map's own hue.
//
// The middle rung is the one that earns its place. Thumb coverage is 1:1 with the originals
// (scripts/build-map-thumbs.py builds one per original), so a missing thumb normally means a
// missing picture — except for art uploaded through Admin AFTER the tier was built, which lands
// as an original with no thumb yet. Without the step down, every one of those would show the
// generated tile even though a real screenshot exists.
//
// We remember WHICH urls failed, not just that something did. Somewhere like the party rail
// there is a single long-lived MapBanner whose map changes as you pick different ones — a plain
// boolean would latch on the first missing image and then show the placeholder for every map
// afterwards, including ones whose art exists. Keying on the url means a new map's candidates
// are simply unseen, so they get tried.
export default function MapBanner({ map, src }) {
  const [failed, setFailed] = useState(() => new Set())
  // An explicit src is a caller naming the exact image it wants (the map page hero, the admin
  // replace preview with its cache-buster) — no stepping, that IS the picture.
  const chain = (src ? [src] : [map.banner, map.bannerLarge]).filter(Boolean)
  const url = chain.find((u) => !failed.has(u)) || null
  if (url) {
    return (
      <img
        className="map-banner"
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed((s) => new Set(s).add(url))}
      />
    )
  }
  const h = map.hue ?? 30
  const bg = `linear-gradient(160deg,
      hsl(${h} 22% 30%) 0%,
      hsl(${h} 18% 20%) 55%,
      hsl(${(h + 20) % 360} 15% 14%) 100%)`
  return (
    <div className="map-banner-ph" style={{ background: bg }}>
      <svg width="100%" height="100%" viewBox="0 0 100 133" preserveAspectRatio="none"
           style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
        <path d="M0 40 Q 25 20 50 42 T 100 38" stroke="#fff" fill="none" strokeWidth="0.6" />
        <path d="M0 66 Q 30 48 55 70 T 100 64" stroke="#fff" fill="none" strokeWidth="0.6" />
        <path d="M0 92 Q 20 78 50 96 T 100 90" stroke="#fff" fill="none" strokeWidth="0.6" />
      </svg>
    </div>
  )
}
