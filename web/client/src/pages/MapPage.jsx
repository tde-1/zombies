import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { usePlayGate } from '../components/playGate'
import { setAmbienceOverride, gradeAmbient, WAW_DEFAULT } from '../ambience'
import { sampleImageColors } from '../data/sampleColors'
import { prettyTitle, releasedOf } from '../data/mapText'
import { api, clock, num } from '../api'
import { useSession } from '../session'
import { useRail } from '../rail'
import { Section, Empty, Loading, Health, Untracked, PlayerLink, NotPlayable, NewOnServer } from '../components/Bits'
import BackButton from '../components/BackButton'
import Comments from '../components/Comments'
import { DownloadButton } from '../components/MapDownload'
import './MapPage.css'

// The map page, redesigned as Movement's (2026-09-22, B: "I kind of like what we've done here,
// but redesign the map page to make it look a bit nicer"). The shape is Movement's
// `components/MapDashboard.jsx` — its CSS is `.mapdash` and friends in theme.css, copied —
// with zombies' facts in the places Movement puts a surf map's:
//
//   THE BANNER    the picture at a proper 16:9 on the left, and beside it, in the same panel,
//                 the map's name, what it is (creator, release, size, how it ends), the
//                 standing (the best round on the board, yours, how many have beaten it) and
//                 Play at the foot. Movement's R1 "Inset": two closed shapes in one panel.
//   ~~WHAT'S IN IT~~  removed 2026-09-23 (B: "Get rid of 'What's in it' for now"). The
//                 payload still carries `features`; nothing draws it. Parked idea: a weapon
//                 index (questions.md, "Parked ideas").
//   TWO TABS      (2026-09-23, B: "put the records behind ... in its own tab below")
//                 About: the description beside the comments, as it was. Records: Movement's
//                 one-map board a size up, one row per run, Watch on the row.
//   FILES         at the foot, behind one small button that opens a pop-over (B: "hide it
//                 behind a little pop-up").
//
// The page is still one body in two frames: /m/<map> — the YouTube deep link, which must
// never change — and home's right-hand region render this same component.
//
// ~~The referee's finish table and watched signals were drawn from its manifest.~~ Removed
// 2026-09-23 as a player-facing section; the banner's "Beaten by ... by reaching round N"
// comes from the same map row.
export default function MapPage() {
  const { key } = useParams()
  const R = useRail()
  // Opening a map stages it on the rail's card when that moves nobody else — Movement's flow,
  // where the map you open is the map you would launch. With no party it is your own stage
  // and costs nothing; a party's map is the leader's, and only the card or its picker (or
  // home's pool, for the leader) moves it, so reading a map page never resets a lobby.
  useEffect(() => {
    if (R && R.signedIn && !R.party && key) R.stageMap(key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, R && R.signedIn, R && !!R.party])
  return <div className="page wide mapdash-card"><BackButton /><MapBody mapKey={key} /></div>
}

// The map's own colour, as Movement's --map-c: "H S% L%", sampled from the art in the browser
// with the extractor the ambience uses, and put through the ambience's own grade so the page
// and the ground behind it are one atmosphere. No art (or no sample yet) is the WaW pair.
function useMapColour(art) {
  const [c, setC] = useState(null)
  useEffect(() => {
    let dead = false
    setC(null)
    sampleImageColors(art).then((s) => { if (!dead) setC(s) })
    return () => { dead = true }
  }, [art])
  const s = c || WAW_DEFAULT
  const a = gradeAmbient({ h: s.h, s: s.s, l: s.l })
  const b = gradeAmbient({ h: s.h2 ?? s.h, s: s.s2 ?? s.s, l: s.l2 ?? s.l })
  return { '--map-c': `${a.h} ${a.s}% ${a.l}%`, '--map-c2': `${b.h} ${b.s}% ${Math.max(18, b.l - 6)}%` }
}

const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`)

// ~~PICTURE: a credit line under the picture ("Screenshot from the release post")~~ removed
// 2026-09-23 as page noise. The generated card still says NO SCREENSHOT ON FILE on its own
// face, and the Cover | Loading screen switch names the second picture.

const readTab = () => { try { return window.location.hash === '#records' ? 'records' : 'about' } catch { return 'about' } }

export function MapBody({ mapKey: key }) {
  const { signedIn, approved } = useSession()
  const R = useRail()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [version, setVersion] = useState(null)
  const [shot, setShot] = useState('art')
  // Which tab under the banner. `#records` opens on the board, so a link can point at it.
  const [tab, setTabState] = useState(readTab)
  const setTab = (t) => {
    setTabState(t)
    try {
      const u = window.location.pathname + window.location.search + (t === 'records' ? '#records' : '')
      window.history.replaceState(window.history.state, '', u)
    } catch { /* no history */ }
  }

  const load = useCallback(() => {
    const qs = version ? `?version=${version}` : ''
    api.get(`/api/maps/${encodeURIComponent(key)}${qs}`).then(setD).catch((e) => setErr(e.message))
  }, [key, version])

  useEffect(() => { setD(null); setShot('art'); load() }, [load])

  // This map COMMITS the site's atmosphere: the projection steps up and nothing on the page
  // but another map can move it. Cleared on the way out so the page that follows is not lit
  // by a map nobody is looking at any more.
  useEffect(() => {
    if (!d || !d.map) return undefined
    setAmbienceOverride({ key: d.map.key, art: d.map.art })
    return () => setAmbienceOverride(null)
  }, [d && d.map && d.map.key, d && d.map && d.map.art])

  const colour = useMapColour(d && d.map ? d.map.art : null)

  if (err && !d) return <><h1>{err}</h1><Link className="btn" to="/maps">Back to the maps</Link></>
  if (!d) return <Loading />

  const m = d.map
  const title = prettyTitle(m.title, m.key)
  const released = releasedOf(m)
  const dl = m.download || {}
  // Play here is the RAIL's Play with this map staged first — Movement's map page "Spin up"
  // is the rail's launch too, so there is one way to start a game and one place (the server
  // card) that shows where it has got to. The play gate is inside it: in a plain browser this
  // goes to /download carrying this map, inside the launcher it carries on.
  // ~~`POST /api/maps/:key/play`, which only staged the map~~ — the route stays for the
  // launcher; the page no longer calls it.
  const play = () => R.play({ mapKey: m.key })
  const rate = async (t) => { try { await api.post(`/api/maps/${m.key}/rate`, { thumbs: t }); load() } catch (e) { setErr(e.message) } }
  const fav = async () => { await api.post(`/api/maps/${m.key}/favourite`, { on: !m.favourite }); load() }

  // The standing. The best round anyone has on the round board, across every player count,
  // with who and how many; then yours; then how many have beaten it. Movement's three figures,
  // with a round where it has a time.
  const top = bestRound(d.boards)
  const runs = (d.boards || []).reduce((n, b) => n + b.counts.reduce((k, c) => k + c.rows.length, 0), 0)
  const catalogued = m.health === 'catalogued'
  const picture = shot === 'loadscreen' && m.loadscreen ? m.loadscreen : m.art

  return (
    <div className="mapdash-wrap">
    <div className="mapdash" style={colour}>
      {/* The map's own artwork, blurred huge, is the room the page sits in. */}
      <div className="mapdash-atmo" aria-hidden="true">
        {m.art && <img className="map-banner" src={m.art} alt="" />}
      </div>

      <div className="mapdash-banner mapdash-two">
        <div className="mapdash-still">
          {picture
            ? <img className="map-banner" src={picture} alt={`${title}`} />
            : <span className="mapdash-none">no picture</span>}
          {m.loadscreen && (
            <div className="mapdash-shots seg" role="tablist" aria-label="Which picture">
              <button role="tab" aria-selected={shot === 'art'} className={shot === 'art' ? 'on' : ''} onClick={() => setShot('art')}>Cover</button>
              <button role="tab" aria-selected={shot === 'loadscreen'} className={shot === 'loadscreen' ? 'on' : ''} onClick={() => setShot('loadscreen')}>Loading screen</button>
            </div>
          )}
        </div>

        <div className="mapdash-side">
          <div className="mapdash-id">
            <div className="mapdash-name">
              {title}
              {signedIn && (
                <button
                  type="button"
                  className={'mapdash-fav' + (m.favourite ? ' on' : '')}
                  aria-pressed={!!m.favourite}
                  title={m.favourite ? 'Remove from favourites' : 'Save to favourites'}
                  aria-label={m.favourite ? 'Remove from favourites' : 'Save to favourites'}
                  onClick={fav}
                ><StarIcon on={!!m.favourite} /></button>
              )}
            </div>
            <div className="mapdash-bsp mono">{m.key.startsWith('cat:') ? 'not yet archived' : m.key}</div>
            {/* What the map IS, one line, dots drawn by the row so an absent fact takes its
                separator with it. Every item is a fact the site holds; none is invented. */}
            <div className="mapdash-facts">
              {m.author && <Link className="mapdash-by" to={`/creator/${encodeURIComponent(m.author)}`}>Created by {m.author}</Link>}
              {released && <span>Released {released}</span>}
              {dl.size_bytes ? <span><b>{mb(dl.size_bytes)}</b></span> : null}
              {m.source === 'stock' && <span>Ships with WaW</span>}
            </div>
            <div className="mapdash-chips">
              {m.has_ee && <span className="tag gold">Easter egg</span>}
              {m.has_buyable && <span className="tag hot">Buyable ending</span>}
              {m.tags.filter((t) => !['easter-egg', 'buyable-ending', 'top-100', 'archive_file', 'archive-file', 'archive_item', 'archive-item'].includes(t.slug)).slice(0, 5)
                .map((t) => <Link className="tag" key={t.slug} to={`/maps?tag=${t.slug}`}>{t.label}</Link>)}
              {m.tags.some((t) => t.slug === 'top-100') && <span className="tag">Top 100</span>}
              <Health health={m.health} />
              {!catalogued && <NotPlayable map={m} />}
              {!catalogued && <NewOnServer map={m} />}
            </div>
          </div>

          <div className="mapdash-figs">
            <div className="mdfig mdfig-record">
              <div className="mdfig-k">Best round</div>
              <div className="mdfig-v gold">{top ? top.round : '—'}</div>
              <div className="mdfig-s">
                {top ? top.who : 'no runs yet'}
                {top && <span className="mdfig-pts">{top.count === 1 ? 'solo' : `${top.count}p`}</span>}
              </div>
            </div>
            <div className="mdfig mdfig-mine">
              <div className="mdfig-k">Your best</div>
              <div className={'mdfig-v' + (m.progress && m.progress.best_round ? ' mine' : '')}>
                {m.progress && m.progress.best_round ? m.progress.best_round : '—'}
              </div>
              <div className="mdfig-s">
                {!signedIn ? 'Sign in to see yours' : m.progress && m.progress.beaten ? 'beaten' : m.progress && m.progress.games ? `${m.progress.games} ${m.progress.games === 1 ? 'game' : 'games'}` : 'not played'}
              </div>
            </div>
            <div className="mdfig mdfig-global">
              <div className="mdfig-k">Beaten by</div>
              <div className="mdfig-v">{num(m.beaten_by)}</div>
              <div className="mdfig-s">{finishWord(m)}</div>
            </div>
            <div className="mdfig mdfig-behind">
              <div className="mdfig-k">Games</div>
              <div className="mdfig-v">{num(m.plays)}</div>
              <div className="mdfig-s">{m.rating != null ? `${m.rating}% rating` : ''}</div>
            </div>
          </div>

          <div className="mapdash-play">
            {/* Not playable on our servers (web-cleanup): Play is disabled with the reason on
                hover, and the chip above says so. A catalogued map has nothing to run at all,
                so it gets no Play Local either. */}
            {catalogued ? (
              <button className="playbtn" disabled title={m.server_note || 'Catalogued, not archived yet'}>Not playable</button>
            ) : (
              <>
                <button className="playbtn" onClick={play} disabled={!approved || m.on_server === false}
                        title={m.on_server === false ? (m.server_note || undefined) : undefined}>
                  {!approved && signedIn ? 'Approval required' : m.on_server === false ? 'Not playable' : d.live.length ? 'Join' : 'Play'}
                </button>
                <div className="mapdash-play-row">
                  {/* Play Local launches WaW straight into the map on the player's own PC,
                      with the console and cheats available, so nothing from it counts. */}
                  {/* Download, separate from Play (updates-downloads, 0.2.11): get the map now,
                      play it later without waiting on the download in the party. */}
                  <DownloadButton mapKey={m.key} />
                  <PlayLocal mapKey={m.key} onError={setErr} />
                  {signedIn && (
                    <span className="mapdash-rate">
                      <button className={'mapdash-tool' + (m.my_rating === 1 ? ' on' : '')} onClick={() => rate(m.my_rating === 1 ? 0 : 1)} title="Rate up">▲ {m.thumbs_up}</button>
                      <button className={'mapdash-tool' + (m.my_rating === -1 ? ' on' : '')} onClick={() => rate(m.my_rating === -1 ? 0 : -1)} title="Rate down">▼ {m.thumbs_down}</button>
                    </span>
                  )}
                </div>
              </>
            )}
            {err && <div className="playbtn-note hot">{err}</div>}
          </div>
        </div>
      </div>

      {m.guides && m.guides.length > 0 && <Guides key={m.key} mapKey={m.key} guides={m.guides} />}

      {/* Two tabs under the banner (B, 2026-09-23): About with the comments beside it, as it
          was, and Records on its own. The count on the Records tab is how many runs are on
          the map's boards, so nobody clicks through to an empty table to find out. */}
      <div className="mdtabs" role="tablist" aria-label="Map sections">
        <button type="button" role="tab" aria-selected={tab === 'about'} className={'mdtab' + (tab === 'about' ? ' on' : '')} onClick={() => setTab('about')}>About</button>
        <button type="button" role="tab" aria-selected={tab === 'records'} className={'mdtab' + (tab === 'records' ? ' on' : '')} onClick={() => setTab('records')}>
          Records{runs > 0 && <b className="mdtab-n">{runs}</b>}
        </button>
      </div>

      {tab === 'records' ? (
        <section className="mdrec-wrap" aria-label="Records">
          <Records boards={d.boards} modes={d.map && d.map.modes} />
          {/* ~~Recent games~~ removed 2026-09-23: on a played map it was a list of R0 games
              with nobody's name on them, under the board that already ranks the real runs.
              `recent` stays on the wire. */}
        </section>
      ) : (
      <div className="mapdash-split">
        <div className="mds-main">
          <Section title="About">
            {/* 13 §3: the archived release post and readme ARE the description. */}
            <div className="mds-about">
              {m.description ? <p className="mds-desc">{m.description}</p> : <Empty>No description yet.</Empty>}
              {m.release_post && (
                <p className="tiny" style={{ marginTop: 8, marginBottom: 0 }}>
                  Release post: <a href={m.release_post} target="_blank" rel="noreferrer noopener">{hostOf(m.release_post)}</a>
                </p>
              )}
              {/* The finish scanner's own line ("Scanner verdict: …") is not the map's readme;
                  on 2026-09-23 it was the whole of every readme on the site. */}
              {readmeOf(m.readme) && <pre className="block" style={{ whiteSpace: 'pre-wrap' }}>{readmeOf(m.readme)}</pre>}
            </div>
          </Section>

          {/* ~~Records, Recent games~~ moved to the Records tab. ~~What counts as beating it~~
              removed 2026-09-23: the referee's finish table (with its Priority column) is the
              box's business; "Beaten by ... by reaching round N" in the banner says it for a
              player. ~~Download~~ is the Files pop-over at the foot of the page. */}
        </div>

        <div className="mds-comments">
          {d.live.length > 0 && (
            <Section title="Live now">
              <div className="listing">
                <table className="data">
                  <tbody>
                    {d.live.map((g) => (
                      <tr key={g.match_id}>
                        <td>{g.players.map((p) => p.name).join(', ') || 'A game'}<div className="tiny">{g.mode} · {g.player_count}/4</div></td>
                        <td className="num"><Link className="mapdash-tool" to={`/live/${g.match_id}`}>Watch</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {d.friends_beaten.length > 0 && (
            <Section title="Friends who beat it">
              <div className="row wrap">{d.friends_beaten.map((x) => <PlayerLink key={x.steam_id} user={x} />)}</div>
            </Section>
          )}

          <Section title="Comments">
            <Comments kind="map" subject={m.key} initial={d.comments} onChange={load} />
          </Section>
        </div>
      </div>
      )}

      {/* The foot: the files behind one small button, and the version picker where a map has
          more than one version. */}
      <div className="mdfoot">
        <Files mapKey={m.key} files={d.map.files || []} sources={d.sources || []} catalogued={catalogued} />
        {d.map.versions.length > 1 && (
          <label className="mdfoot-ver">
            <span className="tiny">Version</span>
            <select value={version || d.map.version_id} onChange={(e) => setVersion(Number(e.target.value))}>
              {d.map.versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.latest ? ' (latest)' : ''}</option>)}
            </select>
          </label>
        )}
      </div>
    </div>
    </div>
  )
}

const readmeOf = (t) => String(t || '').split('\n').filter((l) => !/^\s*Scanner verdict:/i.test(l)).join('\n').trim()

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, '') } catch { return u } }

function finishWord(m) {
  if (m.main_finish === 'easter_egg') return 'by the Easter egg'
  if (m.main_finish === 'buyable_ending') return 'by the buyable ending'
  return `by reaching round ${m.round_n || 20}`
}

// The best round on the map's round board, across player counts.
function bestRound(boards) {
  const b = (boards || []).find((x) => x.category === 'round')
  if (!b) return null
  let best = null
  for (const c of b.counts) {
    const r = c.rows[0]
    if (r && (!best || r.round > best.round)) {
      best = { round: r.round, count: c.player_count, who: r.players.map((p) => p.name).join(', ') }
    }
  }
  return best
}

// ---- the Easter egg -----------------------------------------------------------------------
// B (2026-09-23): the steps are there if you want them and hidden if you do not. The section
// only exists when the archive found a guide (lib/guides.js; archive/easter_eggs.py reads the
// release posts and threads we hold). The steps are blurred until asked for, and the answer
// is remembered per map in this browser — somebody who opened them once does not want to
// click again, and somebody who never has should not have them spoiled by a reload.
//
// Every guide is somebody else's words, so the line under it says whose and where, and
// links out (ip-posture.md). Several guides are tabs: Main quest, Power, Song, and so on.
const revealKey = (k) => `enw.ee.shown.${k}`
function readShown(k) { try { return window.localStorage.getItem(revealKey(k)) === '1' } catch { return false } }
function writeShown(k, on) {
  try { if (on) window.localStorage.setItem(revealKey(k), '1'); else window.localStorage.removeItem(revealKey(k)) } catch { /* private window */ }
}

function Guides({ mapKey, guides }) {
  const [shown, setShown] = useState(() => readShown(mapKey))
  const [pick, setPick] = useState(0)
  const cur = guides[Math.min(pick, guides.length - 1)]
  // A tab says what KIND of guide it is; when two share a kind (two side quests) it says
  // the guide's own title instead, so the tabs never read "Side quest, Side quest".
  const tabName = (g) => (guides.filter((x) => x.tab === g.tab).length > 1 ? g.title : g.tab)
  const show = (on) => { setShown(on); writeShown(mapKey, on) }
  let n = 0
  return (
    <section className="mapdash-feats mdguide" aria-label="Easter egg">
      <div className="mapdash-feats-head">
        <div className="section-label">Easter egg</div>
        {shown && <button type="button" className="mdguide-hide" onClick={() => show(false)}>Hide</button>}
      </div>
      {guides.length > 1 && (
        <div className="mdboards" role="tablist" aria-label="Which guide">
          {guides.map((g, i) => (
            <button key={g.id} role="tab" aria-selected={cur === g} className={'mdboard' + (cur === g ? ' on' : '')} onClick={() => setPick(i)}>
              {tabName(g)}
            </button>
          ))}
        </div>
      )}
      <div className={'mdguide-body' + (shown ? '' : ' veiled')}>
        <div className="mdguide-inner" aria-hidden={!shown}>
          <div className="mdguide-title">
            <b>{cur.title}</b>
            {cur.reward && <span className="tiny">Gets you: {cur.reward}</span>}
          </div>
          <ol className="mdguide-steps">
            {cur.steps.map((s, i) => {
              if (s.head) return <li key={i} className="mdguide-sub">{s.text}</li>
              n += 1
              return (
                <li key={i} value={n}>
                  {s.label && <b className="mdguide-label">{s.label}. </b>}
                  {s.text}
                  {s.details && (
                    <ul className="mdguide-details">{s.details.map((d, j) => <li key={j}>{d}</li>)}</ul>
                  )}
                </li>
              )
            })}
          </ol>
          <GuideSource source={cur.source} />
        </div>
        {!shown && (
          <div className="mdguide-veil">
            <button type="button" className="btn" onClick={() => show(true)}>Show Easter egg steps</button>
          </div>
        )}
      </div>
    </section>
  )
}

function GuideSource({ source }) {
  if (!source) return null
  const who = source.author || 'the author'
  const where = source.site || (source.url ? hostOf(source.url) : null)
  return (
    <p className="tiny mdguide-src">
      From {who}{where ? ' on ' : ''}
      {where && (source.url
        ? <a href={source.url} target="_blank" rel="noreferrer noopener">{where}</a>
        : <span>{where}</span>)}
    </p>
  )
}

function StarIcon({ on }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"
         fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 3.6l2.5 5.4 5.9.7-4.4 4 1.2 5.8L12 16.6 6.8 19.5 8 13.7 3.6 9.7l5.9-.7z" />
    </svg>
  )
}

// Play Local (13 §3, §4). `window.enw` is the launcher's preload bridge (launcher.md §4).
// In a plain browser it is absent and there is nothing to launch.
//
// ~~It said so in a red line under the button.~~ Retracted in place, B 2026-09-22: a
// refusal that names a thing you do not have is only half an answer. It goes to /download
// now, like every other play action, carrying this map — `components/playGate.js`.
function PlayLocal({ mapKey, onError }) {
  const [busy, setBusy] = useState(false)
  const { guard } = usePlayGate()

  const go = async () => {
    if (guard({ map: mapKey, then: `/m/${mapKey}` })) return
    setBusy(true)
    try {
      const s = await api.post('/api/launcher/local/start', { map_key: mapKey })
      await window.enw.playLocal(s)
    } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="mapdash-tool" disabled={busy} onClick={go}>{busy ? 'Starting' : 'Play Local'}</button>
      <Untracked />
    </span>
  )
}

// The link checker's verdict, as it found it. `fetched` means we have the bytes, which is
// the only status that survives the link going dead.
function LinkHealth({ status }) {
  if (status === 'fetched') return <span className="tag good">Held</span>
  if (status === 'alive') return <span className="tag good">Alive</span>
  if (status === 'dead') return <span className="tag hot">Dead</span>
  if (status === 'blocked') return <span className="tag">Blocked</span>
  return <span className="tag">Unchecked</span>
}

// ---- the files, behind one button ----------------------------------------------------------
// B (2026-09-23): "I like having the downloads at the bottom; maybe hide it behind a little
// pop-up." One small button at the foot says how many files; it opens a pop-over with the
// install action on top and one line per file: name, size, where it comes from. It closes on
// Esc, on a click outside it, and on the button again.
const baseName = (p) => String(p || '').split(/[\\/]/).pop()

function Files({ mapKey, files, sources, catalogued }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const originals = files.filter((x) => x.kind === 'original')
  const links = sources.filter((s) => s.kind !== 'page')
  const n = originals.length + links.length
  // Nothing on record: no button. The banner's Download is the install action either way.
  if (!n) return null
  return (
    <div className="mdfiles" ref={box}>
      <button type="button" className="mapdash-tool mdfiles-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Files{n ? <b className="mdtab-n">{n}</b> : null}
      </button>
      {open && (
        <div className="mdfiles-pop" role="dialog" aria-label="Files">
          {!catalogued && <div className="mdfiles-act"><DownloadButton mapKey={mapKey} /></div>}
          <ul className="mdfiles-list">
            {originals.map((x) => (
              <li key={x.path} className="mdfile">
                <span className="mdfile-n mono" title={x.sha256 ? `sha256 ${x.sha256}` : undefined}>{baseName(x.path)}</span>
                <span className="mdfile-s">{x.size ? mb(x.size) : ''}</span>
                <span className="mdfile-src"><span className="tag good">ENW archive</span></span>
              </li>
            ))}
            {links.map((s, i) => (
              <li key={i} className="mdfile">
                <a className="mdfile-n" href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>{s.site || hostOf(s.url)}</a>
                <span className="mdfile-s">{s.size_bytes ? mb(s.size_bytes) : ''}</span>
                <span className="mdfile-src"><LinkHealth status={s.status} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---- the records tab ------------------------------------------------------------------------
// Movement's one-map board (RecordTable density="board": rank, player, time, points, behind,
// date, Watch) a size up, with zombies' figures where Movement has surf ones. Watch is on the
// row and goes straight to the replay viewer (/replay/:matchId). Only boards with runs get a
// chip and only player counts with runs get a button; a column every row leaves empty (Time on
// a board without durations, Kills and Downs until the box reports them) is not drawn.
const ORDER = ['round', 'ee_speedrun', 'buyable_speedrun', 'no_power', 'no_perks', 'no_jug', 'first_room']
const hasRuns = (b) => b.counts.some((c) => c.rows.length)
const pcLabel = (n) => (n === 1 ? 'Solo' : `${n}p`)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (ms) => {
  if (!ms) return '—'
  const t = new Date(ms)
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`
}

// A map with its own game modes (docs/kickstart/game-modes.md: UGX's Classic / Gun Game / ...)
// keeps a board per mode, and a mode is only ever ranked against itself, so the mode is the
// first choice here: one tab per mode that has runs, in the map's own order.
function Records({ boards, modes }) {
  const [pick, setPick] = useState(null)
  const [pc, setPc] = useState(null)
  const [gm, setGm] = useState(null)
  const withRuns = [...(boards || [])].filter(hasRuns)
  const order = (modes && modes.modes ? modes.modes.map((m) => m.id) : [])
  const modeIds = [...new Set(withRuns.map((b) => b.game_mode || ''))]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
  const modeName = (id) => (id ? ((withRuns.find((b) => b.game_mode === id) || {}).game_mode_label || id) : 'Before modes')
  const curMode = modeIds.includes(gm) ? gm : (modeIds.includes(modes && modes.default) ? modes.default : modeIds[0])
  const shown = withRuns.filter((b) => (b.game_mode || '') === (curMode || ''))
    .sort((a, b) => ORDER.indexOf(a.base || a.category) - ORDER.indexOf(b.base || b.category))
  if (!shown.length) return <div className="mdrec-empty">No records yet.</div>
  const cur = shown.find((b) => b.category === pick) || shown[0]
  const counts = cur.counts.filter((c) => c.rows.length)
  const sel = counts.find((c) => c.player_count === pc) || counts[0]
  return (
    <div className="mdrec">
      {modeIds.length > 1 || (modes && curMode) ? (
        <div className="mdrec-bar mdrec-modes">
          {modeIds.length > 1 ? (
            <div className="mdscope" role="tablist" aria-label="Game mode">
              {modeIds.map((id) => (
                <button key={id || 'none'} type="button" role="tab" aria-selected={id === curMode} className={'mdscope-b' + (id === curMode ? ' on' : '')} onClick={() => { setGm(id); setPick(null); setPc(null) }}>{modeName(id)}</button>
              ))}
            </div>
          ) : <span className="mdrec-label">{modeName(curMode)}</span>}
        </div>
      ) : null}
      <div className="mdrec-bar">
        {shown.length > 1 ? (
          <div className="mdboards" role="tablist" aria-label="Which board">
            {shown.map((b) => (
              <button key={b.category} type="button" role="tab" aria-selected={cur === b} className={'mdboard' + (cur === b ? ' on' : '')} onClick={() => setPick(b.category)}>{b.label}</button>
            ))}
          </div>
        ) : <div className="mdrec-label">{cur.label}</div>}
        {counts.length > 1 ? (
          <div className="mdscope" role="tablist" aria-label="Players">
            {counts.map((c) => (
              <button key={c.player_count} type="button" role="tab" aria-selected={c === sel} className={'mdscope-b' + (c === sel ? ' on' : '')} onClick={() => setPc(c.player_count)}>{pcLabel(c.player_count)}</button>
            ))}
          </div>
        ) : <span className="mdrec-label mdrec-pc">{pcLabel(sel.player_count)}</span>}
      </div>
      <RecordBoard key={`${cur.category}-${sel.player_count}`} board={cur} rows={sel.rows} />
    </div>
  )
}

function RecordBoard({ board, rows }) {
  const { me } = useSession()
  const time = board.sort === 'time_asc'
  const hasTime = rows.some((r) => r.value_ms > 0)
  // Kills and downs are wired (lib/records.js sums the game's player rows) and hidden while
  // every row says 0 or nothing, which is every row until the box reports them.
  const hasKills = rows.some((r) => r.kills > 0)
  const hasDowns = rows.some((r) => r.downs > 0)
  const hasWatch = rows.some((r) => r.replay && r.match_id)
  const cols = [
    { h: '#', w: '56px', c: (r) => <span className={'mdrec-rank' + (r.rank === 1 ? ' gold' : '')}>{r.rank}</span> },
    { h: 'Players', w: 'minmax(0, 1fr)', l: true, c: (r) => <Who r={r} /> },
    time
      ? { h: 'Time', w: '130px', c: (r) => <span className={'mdrec-t' + (r.rank === 1 ? ' top' : '')}>{clock(r.value_ms)}</span> }
      : { h: 'Round', w: '96px', c: (r) => <span className={'mdrec-t' + (r.rank === 1 ? ' top' : '')}>{r.round}</span> },
    time
      ? { h: 'Round', w: '84px', c: (r) => <span className="mdrec-n">{r.round}</span> }
      : hasTime ? { h: 'Time', w: '112px', c: (r) => <span className="mdrec-n">{clock(r.value_ms)}</span> } : null,
    hasKills ? { h: 'Kills', w: '84px', t: 'Team kills in that game', c: (r) => <span className="mdrec-n">{r.kills ?? '—'}</span> } : null,
    hasDowns ? { h: 'Downs', w: '84px', t: 'Team downs in that game', c: (r) => <span className="mdrec-n">{r.downs ?? '—'}</span> } : null,
    { h: 'Date', w: '124px', c: (r) => <span className="mdrec-n" title={r.at ? new Date(r.at).toLocaleString() : undefined}>{day(r.at)}</span> },
    hasWatch ? {
      h: '', w: '92px',
      c: (r) => (r.replay && r.match_id
        ? <Link className="btn small mdrec-watch" to={`/replay/${encodeURIComponent(r.match_id)}`}>Watch</Link>
        : null),
    } : null,
  ].filter(Boolean)
  const style = { '--mdrec-cols': cols.map((c) => c.w).join(' ') }
  return (
    <div className="mdrec-tab" style={style}>
      <div className="mdrec-head">
        {cols.map((c, i) => <span key={i} className={c.l ? 'l' : ''} title={c.t}>{c.h}</span>)}
      </div>
      {rows.map((r) => {
        const mine = me && r.players.some((p) => String(p.steam_id) === String(me.steam_id))
        return (
          <div className={'mdrec-row' + (mine ? ' me' : '')} key={r.id}>
            {cols.map((c, i) => <span key={i} className={c.l ? 'l' : ''}>{c.c(r)}</span>)}
          </div>
        )
      })}
    </div>
  )
}

// A run's players: each with their picture, as Movement's holder cell. A run that broke the
// board's rules keeps its place and says so on hover.
function Who({ r }) {
  return (
    <span className="mdrec-who">
      {r.players.map((p) => <PlayerLink key={p.steam_id} user={p} />)}
      {!r.profile_ok && <span className="tag hot" title={r.profile_note || undefined}>Rules mismatch</span>}
    </span>
  )
}
