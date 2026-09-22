import MapRow from './MapRow'
import MapCard from './MapCard'

// The home rows — Movement's mode home, which is rows of map cards above the whole pool.
//
// B named three (2026-09-22): **New maps**, **Vanilla** (the four that shipped with World at
// War) and **High production** (big undertakings, seeded with Leviathan). They are NOT in
// this file, and that is the point: "make the row membership a collections/playlist-like
// table editable from admin, not hard-coded". So this component draws whatever
// `/api/maps/home` sends in `rows`, in the order it sends them, and an admin adding a fourth
// row tonight needs no deploy.
//
// A row that resolves to no maps is already dropped server-side (lib/collections.js): an
// empty shelf reads as a broken site rather than as a row nobody has filled in yet. This
// component therefore never has to draw an empty state, and does not pretend to.

export default function MapRows({ rows, onOpen }) {
  if (!rows || !rows.length) return null
  return (
    <>
      {rows.map((r) => (
        <MapRow
          key={r.slug}
          title={r.name}
          blurb={r.blurb}
          count={r.maps.length}
          onOpen={onOpen ? () => onOpen(r) : undefined}
        >
          {r.maps.map((m) => <MapCard key={m.key} map={m} />)}
        </MapRow>
      ))}
    </>
  )
}
