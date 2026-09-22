import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, num } from '../api'
import { useSession } from '../session'
import { useRail } from '../rail'
import { Loading, Lockup } from '../components/Bits'
import MapListPanel from '../components/MapListPanel'
import MapRows from '../components/MapRows'
import { MapBody } from './MapPage'
import BackButton from '../components/BackButton'
import { setBaseAmbience } from '../ambience'

// HOME IS THE MAP BROWSER (B, 2026-09-22).
//
// Movement's map browser, with zombies' nouns. Left of it, on every page, is the party rail
// (components/PartyRail.jsx, B 2026-09-22 evening) — online players, your party, and the
// server card with Play. On home the next column is the scrolling map pool with its search,
// and picking from it stages the map on that card. Everything else is the selected map's own
// page — the same component /m/<map> renders. ~~Left column: the party on top~~ — the party
// panel moved into the rail. There is still no right column.
//
// What this page REPLACED, and why none of it came back: live games, friends online, map of
// the week, featured, and a records/badges feed. Every one of those was a list of rows that
// the site can now only fill honestly with real play — and on the morning of the beta there
// is none, because the demo data was wiped (`tools/wipe-demo.js`). Five empty panels is a
// site that looks broken; the map pool is two thousand true rows. When there are games
// worth listing they belong on the map's own page, where they already are ("Live now",
// "Recent games"), next to the map they were played on.
//
// The background is the selected map's art (`ambience.js`). With nothing selected it is the
// WaW default pair — olive and dried blood — poured through the identical grade and tween,
// so picking a map reads as the map arriving rather than as the site changing.

export default function Home() {
  const R = useRail()
  const maps = R.pool
  const [rows, setRows] = useState(null)
  // ~~It followed the card's map~~ (2026-09-22 late): the card opens that map's own page now
  // (Movement's flow), so home no longer mirrors it. Home opens on the rows; picking from the
  // list opens a map here, and its back control returns to the rows.
  const [sel, setSel] = useState(null)

  useEffect(() => {
    // The home ROWS — New maps, Vanilla, High production — off `collections`, which an admin
    // owns (B, 2026-09-22). They fill the right-hand region when no map is open, which is
    // the region that used to say "Pick a map" and nothing else.
    api.get('/api/maps/home').then((j) => setRows(j.rows || [])).catch(() => setRows([]))
  }, [R.signedIn])

  const selected = useMemo(() => (maps || []).find((m) => m.key === sel) || null, [maps, sel])

  // The BASE tier of the ambience: what the page is about when nothing is hovered and no map
  // page has taken the override. Null is the WaW default, which is the whole point of having
  // a default at all.
  useEffect(() => {
    setBaseAmbience(selected ? { key: selected.key, art: selected.art } : null)
    return () => setBaseAmbience(null)
  }, [selected && selected.key, selected && selected.art])

  const pick = async (m) => {
    setSel(m.key)
    // Opening a map STAGES it on the rail's card — Movement's flow, where the map you open is
    // the map you would launch. Only where that moves nobody else: with no party it is your
    // own stage, and a leader of a party still forming is the one who picks anyway. A member,
    // or a leader mid ready check, is reading, and the card stays where the party put it.
    if (R.signedIn && R.editable) R.stageMap(m.key)
  }

  if (!maps) return <div className="page"><Loading /></div>

  return (
    <div className="home">
      <div className="home-left">
        {!R.signedIn && <SignIn count={maps.length} />}
        <MapListPanel maps={maps} selected={sel} onPick={pick} />
      </div>

      <div className="home-right">
        {sel
          ? <><BackButton onClick={() => setSel(null)} /><MapBody mapKey={sel} /></>
          : <Nothing count={maps.length} rows={rows} />}
      </div>
    </div>
  )
}

// Signed out, in the party's place. It says the one true thing about the site and offers the
// one button that does anything. Steam sign-in is the only way in (B, 2026-09-22), and the
// dev sign-in page it used to fall back to no longer exists anywhere.
function SignIn({ count }) {
  return (
    <section className="ppanel">
      <Lockup h={40} />
      <p className="sub" style={{ margin: '10px 0 12px' }}>
        World at War custom zombies.
      </p>
      <a className="btn primary" style={{ width: '100%' }} href="/auth/steam">Sign in with Steam</a>
      <p className="tiny" style={{ margin: '10px 0 0' }}>
        {num(count)} maps · <Link to="/download">Get the launcher</Link>
      </p>
    </section>
  )
}

// No map open — so the region is Movement's mode home: the rows, then the way into the
// whole pool.
//
// ~~Deliberately almost nothing: the list beside it is the invitation, and a panel of
// suggestions here would be the featured row this page just removed, wearing a different
// hat.~~ **Retracted in place, B 2026-09-22.** The objection to the old featured row was that
// it was a hard-coded guess with nothing behind it; these rows are a table an admin edits
// (`collections`), and B asked for them by name. The empty card stays underneath as the
// state when there are no rows at all — a new database, or every row emptied — because that
// is still better than a blank half-page.
function Nothing({ count, rows }) {
  if (rows && rows.length) {
    return (
      <>
        <MapRows rows={rows} />
        <div className="row" style={{ justifyContent: 'center', marginTop: 4 }}>
          <Link className="btn ghost small" to="/maps">All {num(count)} maps</Link>
          <Link className="btn ghost small" to="/archive">The archive</Link>
          <Link className="btn ghost small" to="/records">Records</Link>
        </div>
      </>
    )
  }
  return (
    <div className="card" style={{ padding: '46px 22px', textAlign: 'center' }}>
      <h2 style={{ marginBottom: 6 }}>Pick a map</h2>
      <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
        <Link className="btn ghost small" to="/archive">The archive</Link>
        <Link className="btn ghost small" to="/records">Records</Link>
      </div>
    </div>
  )
}
