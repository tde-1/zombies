import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ago, clock, num } from '../api'
import { useSession } from '../session'
import { Section, Empty, FinishChips, Health, PlayerLink } from '../components/Bits'
import Comments from '../components/Comments'

// The map page = Movement's storefront (13 §3).
//
//   the big action at the top is Play / Join, with Play Local beside it (clearly marked
//   untracked) and "Download original" below as a secondary link
//   then: the archived release post / readme as the description, the author link, tags,
//   boards, comments, "beaten by N"
//
// Two things here come straight from the referee's manifest rather than from prose: what
// counts as beating this map, and the signals the server watches. Restating those in the
// page's own words would let the page and the box disagree, which is the one disagreement
// that must never happen.

export default function MapPage() {
  const { key } = useParams()
  const { signedIn, approved, refresh } = useSession()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [version, setVersion] = useState(null)

  const load = useCallback(() => {
    const qs = version ? `?version=${version}` : ''
    api.get(`/api/maps/${encodeURIComponent(key)}${qs}`).then(setD).catch((e) => setErr(e.message))
  }, [key, version])

  useEffect(() => { setD(null); load() }, [load])

  if (err) return <div className="page"><h1>{err}</h1><Link className="btn" to="/maps">Back to the maps</Link></div>
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>

  const m = d.map
  const play = async () => {
    try { await api.post(`/api/maps/${m.key}/play`); refresh() } catch (e) { setErr(e.message) }
  }
  const rate = async (t) => { try { await api.post(`/api/maps/${m.key}/rate`, { thumbs: t }); load() } catch (e) { setErr(e.message) } }
  const fav = async () => { await api.post(`/api/maps/${m.key}/favourite`, { on: !m.favourite }); load() }

  return (
    <div className="page wide">
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow">{m.key}</div>
            <h1>{m.title}</h1>
            <div className="row wrap" style={{ gap: 7, marginTop: 8 }}>
              <FinishChips map={m} />
              <Health health={m.health} />
              {m.author && <Link className="chip" to={`/creator/${encodeURIComponent(m.author)}`}>{m.author}</Link>}
              {m.year ? <span className="chip">{m.year}</span> : null}
              {m.tags.map((t) => <Link className="chip" key={t.slug} to={`/maps?tag=${t.slug}`}>{t.label}</Link>)}
            </div>
          </div>
          <div className="stack" style={{ alignItems: 'flex-end' }}>
            <div className="row">
              <button className="btn primary big" onClick={play} disabled={!approved}>
                {d.live.length ? 'Join' : 'Play'}
              </button>
              {/* Play Local is the honest second button: it launches WaW straight into the
                  map on the player's own PC, and nothing about it is tracked (13 §3). In a
                  browser there is nothing to launch, so it says so; inside the launcher it
                  starts a local session the launcher then plays. */}
              <PlayLocal mapKey={m.key} onError={setErr} />
            </div>
            <div className="row">
              {signedIn && (
                <>
                  <button className={`btn small ${m.favourite ? 'on' : 'ghost'}`} onClick={fav}>{m.favourite ? '★ Favourite' : '☆ Favourite'}</button>
                  <button className={`btn small ${m.my_rating === 1 ? 'on' : 'ghost'}`} onClick={() => rate(m.my_rating === 1 ? 0 : 1)} title="Thumbs up">&#128077; {m.thumbs_up}</button>
                  <button className={`btn small ${m.my_rating === -1 ? 'on' : 'ghost'}`} onClick={() => rate(m.my_rating === -1 ? 0 : -1)} title="Thumbs down">&#128078; {m.thumbs_down}</button>
                </>
              )}
            </div>
            <a className="tiny" href="#download" onClick={(e) => { e.preventDefault(); setErr('Downloads need a Steam login and the archive worker; neither is wired up yet.') }}>
              Download original
            </a>
          </div>
        </div>
        {!approved && signedIn && <p className="tiny" style={{ marginTop: 10 }}>Play is waitlist + approval at first. The archive is open to anyone.</p>}
        {err && <p className="tiny hot" style={{ marginTop: 10 }}>{err}</p>}
      </div>

      <div className="stats" style={{ marginBottom: 22 }}>
        <div className="stat"><span>Beaten by</span><b className="num">{num(m.beaten_by)}</b></div>
        <div className="stat"><span>Games</span><b className="num">{num(m.plays)}</b></div>
        <div className="stat"><span>Rating</span><b className="num">{m.rating != null ? `${m.rating}%` : '—'}</b></div>
        <div className="stat"><span>Main finish</span><b>{m.main_finish === 'easter_egg' ? 'Easter Egg' : m.main_finish === 'buyable_ending' ? 'Buyable Ending' : `Round ${m.round_n}`}</b></div>
        {d.map.progress && <div className="stat"><span>Your best</span><b className="num">{d.map.progress.best_round || '—'}</b></div>}
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div>
          <Section title="About">
            {/* 13 §3: the archived release post and readme ARE the description. */}
            {m.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{m.description}</p>
              : <Empty>No description yet. The archived release post goes here once the crawl has one.</Empty>}
            {m.release_post && (
              <p className="tiny">
                From the original release post: <a href={m.release_post} target="_blank" rel="noreferrer noopener">{hostOf(m.release_post)}</a>
              </p>
            )}
            {m.readme && <pre className="block" style={{ whiteSpace: 'pre-wrap' }}>{m.readme}</pre>}
          </Section>

          {m.health === 'catalogued' && (
            <div className="card warn" style={{ marginBottom: 22 }}>
              <div className="eyebrow">Catalogued, not rescued</div>
              <p className="sub" style={{ margin: 0 }}>
                We know this map existed and where it was posted. Nobody has fetched it, hashed it or
                booted it, so it is not on the Maps list and cannot be played here yet.
              </p>
            </div>
          )}

          {d.sources && d.sources.length > 0 && (
            <Section title="Where it came from" sub="The original, and whether those links still work">
              <div className="card">
                <table className="data">
                  <tbody>
                    {d.sources.map((s2, i) => (
                      <tr key={i}>
                        <td className="tiny">{s2.kind === 'page' ? 'Release post' : 'Download'}</td>
                        <td className="mono tiny" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <a href={s2.url} target="_blank" rel="noreferrer noopener">{s2.site || s2.url}</a>
                        </td>
                        <td><LinkHealth status={s2.status} /></td>
                        <td className="tiny">{s2.note || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {d.map.files && d.map.files.filter((f) => f.kind === 'original').length > 0 && (
            <Section title="The original" sub="Kept exactly as it was released">
              {d.map.files.filter((f) => f.kind === 'original').map((f) => (
                <div className="card" key={f.path} style={{ marginBottom: 8 }}>
                  <div className="mono tiny">{f.path}</div>
                  <div className="tiny">{f.size ? `${(f.size / 1048576).toFixed(1)} MB · ` : ''}sha256 <code>{f.sha256}</code></div>
                </div>
              ))}
            </Section>
          )}

          <Section title="What counts as beating it" sub="From the referee manifest — the same rules the server applies">
            {d.map.finishes.length === 0 ? <Empty>No manifest for this map yet; it gets the default, Round 20.</Empty> : (
              <div className="card">
                <table className="data">
                  <thead><tr><th>Finish</th><th>Priority</th><th>Solo</th></tr></thead>
                  <tbody>
                    {d.map.finishes.map((f) => (
                      <tr key={f.id}>
                        <td>{f.label}</td>
                        <td className="num">{f.priority}</td>
                        <td>{f.solo_ok ? 'yes' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.map.signals.length > 0 && (
                  <div className="row wrap" style={{ gap: 5, marginTop: 10 }}>
                    <span className="tiny">Also watched:</span>
                    {d.map.signals.map((s) => <span className="chip" key={s.id}>{s.label}</span>)}
                  </div>
                )}
                {d.map.manifest_notes && <p className="tiny" style={{ marginTop: 10 }}>{d.map.manifest_notes}</p>}
              </div>
            )}
          </Section>

          {d.map.versions.length > 1 && (
            <Section title="Versions" sub="Old versions are frozen boards with basic tracking">
              <select value={version || d.map.version_id} onChange={(e) => setVersion(Number(e.target.value))} style={{ maxWidth: 260 }}>
                {d.map.versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.latest ? ' (latest)' : ''}</option>)}
              </select>
            </Section>
          )}

          <Section title="Comments">
            <Comments kind="map" subject={m.key} initial={d.comments} onChange={load} />
          </Section>
        </div>

        <div>
          <Section title="Boards">
            <Boards boards={d.boards} />
          </Section>

          {d.friends_beaten.length > 0 && (
            <Section title="Friends who have beaten it">
              <div className="row wrap">{d.friends_beaten.map((f) => <PlayerLink key={f.steam_id} user={f} />)}</div>
            </Section>
          )}

          {d.live.length > 0 && (
            <Section title="Being played now">
              <div className="card flat">
                {d.live.map((g) => (
                  <div className="maprow" key={g.match_id}>
                    <div className="name"><b>{g.players.map((p) => p.name).join(', ') || 'A game'}</b><span>{g.mode}</span></div>
                    <span className="chip">{g.player_count}/4</span>
                    <span />
                    <Link className="btn small ghost" to={`/live/${g.match_id}`}>Watch</Link>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Recent games">
            {d.recent.length === 0 ? <Empty>Nobody has played this on our servers yet.</Empty> : (
              <div className="card flat">
                {d.recent.map((g) => (
                  <Link className="maprow" key={g.id} to={`/game/${g.match_id}`}>
                    <div className="name"><b>Round {g.rounds}</b><span>{g.players.map((p) => p.name).join(', ')}</span></div>
                    <span className={`chip ${g.mode === 'local' || g.self_reported ? 'be' : ''}`}>{g.mode}</span>
                    <span className="tiny">{g.finish ? g.finish.label : ''}</span>
                    <span className="tiny">{ago(g.ended_at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}

const hostOf = (u) => { try { return new URL(u).host } catch { return u } }

// Play Local (13 §3, §4). Untracked by definition: it runs on the player's own PC with the
// console and cheats available, so nothing from it can earn a badge, a record or a point
// of XP — and the button says so before it is pressed rather than after.
//
// `window.enw` is the launcher's preload bridge (launcher.md §4). In a plain browser it is
// absent and there is nothing to launch, which is the honest thing to say; the site does
// not pretend to have started a game it cannot start.
function PlayLocal({ mapKey, onError }) {
  const [busy, setBusy] = useState(false)
  const inLauncher = typeof window !== 'undefined' && !!window.enw

  const go = async () => {
    if (!inLauncher) { onError('Play Local needs the launcher. In a browser there is nothing to launch.'); return }
    setBusy(true)
    try {
      const s = await api.post('/api/launcher/local/start', { map_key: mapKey })
      // The launcher takes it from here: install the map if it needs to, launch World at
      // War with fs_game and the account's settings, and post frames and the result back
      // against s.match_id.
      await window.enw.playLocal(s)
    } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  return (
    <button className="btn" disabled={busy}
      title="Launches this map on your own PC. Untracked: no badges, no records, no XP."
      onClick={go}>
      {busy ? 'Starting' : 'Play Local'}
    </button>
  )
}

// The link checker's verdict, as it found it. `fetched` means we have the bytes, which is
// the only status that survives the link going dead.
function LinkHealth({ status }) {
  if (status === 'fetched') return <span className="chip on" title="We hold this file">Held</span>
  if (status === 'alive') return <span className="chip good">Alive</span>
  if (status === 'dead') return <span className="chip be">Dead</span>
  if (status === 'blocked') return <span className="chip">Blocked</span>
  return <span className="chip">Unchecked</span>
}

// Board order and the empty ones.
//
// Every map carries the four ZWR challenge brackets (No Power, No Perks, No Jug, First
// Room) as well as its own categories, and on a map nobody has run yet that is six boards
// all saying "nobody has set one yet". So: the headline boards render in full, and empty
// challenge brackets collapse to one line that still names them — they exist, they are
// open, and saying so in a sentence is more use than six empty tables.
const ORDER = ['round', 'ee_speedrun', 'buyable_speedrun', 'no_power', 'no_perks', 'no_jug', 'first_room']
const CHALLENGE = new Set(['no_power', 'no_perks', 'no_jug', 'first_room'])
const hasRuns = (b) => b.counts.some((c) => c.rows.length)

function Boards({ boards }) {
  if (!boards.length) return <Empty>No boards yet.</Empty>
  const sorted = [...boards].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category))
  const shown = sorted.filter((b) => !CHALLENGE.has(b.category) || hasRuns(b))
  const emptyChallenges = sorted.filter((b) => CHALLENGE.has(b.category) && !hasRuns(b))
  return (
    <>
      {shown.map((b) => <Board key={b.category} board={b} />)}
      {emptyChallenges.length > 0 && (
        <p className="tiny">
          Open with nobody on them: {emptyChallenges.map((b) => b.label).join(', ')}. Each is a locked
          Verified preset with its own board.
        </p>
      )}
    </>
  )
}

function Board({ board }) {
  const [pc, setPc] = useState(board.counts.find((c) => c.rows.length)?.player_count ?? 1)
  const sel = board.counts.find((c) => c.player_count === pc) || board.counts[0]
  const time = board.sort === 'time_asc'
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="spread" style={{ marginBottom: 8 }}>
        <h3>{board.label}</h3>
        <div className="row" style={{ gap: 4 }}>
          {board.counts.map((c) => (
            <button key={c.player_count} className={`btn small ${c.player_count === pc ? 'on' : 'ghost'}`} onClick={() => setPc(c.player_count)}>
              {c.player_count === 1 ? 'Solo' : `${c.player_count}p`}
            </button>
          ))}
        </div>
      </div>
      {!sel || sel.rows.length === 0 ? <Empty>Nobody has set one yet.</Empty> : (
        <table className="data">
          <tbody>
            {sel.rows.map((r) => (
              <tr key={r.id}>
                <td className={`rank num ${r.rank === 1 ? 'r1' : ''}`}>{r.rank}</td>
                <td>{r.players.map((p) => <PlayerLink key={p.steam_id} user={p} avatar={false} />).reduce((a, b) => [a, ', ', b])}</td>
                <td className="num">{time ? clock(r.value_ms) : r.round}</td>
                <td className="tiny">{r.profile_ok ? '' : <span className="hot" title={r.profile_note}>rules mismatch</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
