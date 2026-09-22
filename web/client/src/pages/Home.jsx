import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, num } from '../api'
import { useSession } from '../session'
import { Loading, Lockup } from '../components/Bits'
import PartyPanel from '../components/PartyPanel'
import MapListPanel from '../components/MapListPanel'
import MapRows from '../components/MapRows'
import { MapBody } from './MapPage'
import { setBaseAmbience } from '../ambience'

// HOME IS THE MAP BROWSER (B, 2026-09-22).
//
// Movement's map browser, with zombies' nouns and B's one structural change. Left column:
// the party on top, then the scrolling map pool with its search. Everything else on the
// screen is the selected map's own page — the same component /m/<map> renders, so opening a
// map from the list and following a link to it land on the same page. There is no right
// column: the party rail that used to stand there is gone, and it took the last reason to
// look at three regions at once with it.
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
  const { signedIn } = useSession()
  const [maps, setMaps] = useState(null)
  const [rows, setRows] = useState(null)
  const [party, setParty] = useState(null)
  const [launch, setLaunch] = useState(null)
  // What the page is showing. It follows the party's staged map when there is one, because
  // picking a map is a party action rather than a page action — but it is not the same
  // thing: somebody who is not the leader can still read about a map without moving
  // everybody else's lobby.
  const [sel, setSel] = useState(null)

  useEffect(() => {
    api.get('/api/maps?sort=popular').then((j) => setMaps(j.maps || [])).catch(() => setMaps([]))
    // The home ROWS — New maps, Vanilla, High production — off `collections`, which an admin
    // owns (B, 2026-09-22). They fill the right-hand region when no map is open, which is
    // the region that used to say "Pick a map" and nothing else.
    api.get('/api/maps/home').then((j) => setRows(j.rows || [])).catch(() => setRows([]))
  }, [signedIn])

  const loadParty = useCallback(async () => {
    if (!signedIn) { setParty(null); setLaunch(null); return }
    try {
      const j = await api.get('/api/party')
      setParty(j.party)
      setLaunch(j.launch)
      // Follow the lobby: somebody else's pick has to move this page, or two people in one
      // party are reading about two different maps while one Start button decides.
      if (j.party && j.party.map) setSel((cur) => (cur == null ? j.party.map.key : cur))
    } catch { /* signed out mid-poll */ }
  }, [signedIn])

  useEffect(() => { loadParty() }, [loadParty])
  useEffect(() => {
    if (!signedIn) return undefined
    // Poll rather than push: the party changes when somebody else clicks Ready, and a
    // three-second poll of one small row is cheaper to get right than a per-party room.
    // The one thing that genuinely needs to move between polls — a download bar — has the
    // socket (`party-progress`), which PartyPanel listens to.
    const t = setInterval(loadParty, 3000)
    return () => clearInterval(t)
  }, [signedIn, loadParty])

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
    // Staging it for the party is the leader's move and only the leader's; for anybody else
    // this is reading, and the request would be refused anyway.
    if (party && party.is_leader) {
      try { await api.post('/api/party/map', { map_key: m.key }); loadParty() } catch { /* the panel shows the refusal */ }
    }
  }

  if (!maps) return <div className="page"><Loading /></div>

  return (
    <div className="home">
      <div className="home-left">
        {signedIn
          ? <PartyPanel party={party} launch={launch} onChange={loadParty} selected={sel} />
          : <SignIn count={maps.length} />}
        <MapListPanel maps={maps} selected={sel} onPick={pick} />
      </div>

      <div className="home-right">
        {sel
          ? <MapBody mapKey={sel} />
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
        Every World at War custom zombies map, archived and playable. Refereed on our servers.
      </p>
      <a className="btn primary" style={{ width: '100%' }} href="/auth/steam">Sign in with Steam</a>
      <p className="tiny" style={{ margin: '10px 0 0' }}>
        {num(count)} maps. Browsing needs no account. <Link to="/download">Get the launcher</Link> to play.
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
      <p className="sub" style={{ margin: 0 }}>{num(count)} of them, and the archive holds the rest.</p>
      <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
        <Link className="btn ghost small" to="/archive">The archive</Link>
        <Link className="btn ghost small" to="/records">Records</Link>
      </div>
    </div>
  )
}
