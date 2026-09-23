import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { usePlayGate } from '../components/playGate'
import { setAmbienceOverride, gradeAmbient, WAW_DEFAULT } from '../ambience'
import { sampleImageColors } from '../data/sampleColors'
import { prettyTitle, releasedOf } from '../data/mapText'
import { api, ago, clock, num } from '../api'
import { useSession } from '../session'
import { useRail } from '../rail'
import { Section, Empty, Loading, Health, Untracked, PlayerLink, NotPlayable, NewOnServer } from '../components/Bits'
import BackButton from '../components/BackButton'
import Comments from '../components/Comments'
import { DownloadButton } from '../components/MapDownload'

// The map page, redesigned as Movement's (2026-09-22, B: "I kind of like what we've done here,
// but redesign the map page to make it look a bit nicer"). The shape is Movement's
// `components/MapDashboard.jsx` — its CSS is `.mapdash` and friends in theme.css, copied —
// with zombies' facts in the places Movement puts a surf map's:
//
//   THE BANNER    the picture at a proper 16:9 on the left, and beside it, in the same panel,
//                 the map's name, what it is (creator, release, size, how it ends), the
//                 standing (the best round on the board, yours, how many have beaten it) and
//                 Play at the foot. Movement's R1 "Inset": two closed shapes in one panel.
//   WHAT'S IN IT  the Call of Duty facts: perks, Pack-a-Punch, the box, wall buys, wonder
//                 weapons, hellhounds, traps, teleporters, power — read out of the map's own
//                 fastfile (tools/maps/map_features.py). A map we hold no files for has no
//                 such block, and the page prints nothing rather than a guess.
//   THE SPLIT     the board and the map's own record of itself (description, how it is
//                 beaten, where it came from) keep two thirds; the thread takes the rest.
//
// The page is still one body in two frames: /m/<map> — the YouTube deep link, which must
// never change — and home's right-hand region render this same component.
//
// Two things still come straight from the referee's manifest rather than from prose: what
// counts as beating this map, and the signals the server watches. Restating those in the
// page's own words would let the page and the box disagree.
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

// What the picture IS. A generated card must never pass for a screenshot, and a loading screen
// out of the map's own files is worth saying — it is the picture the game itself shows.
const PICTURE = {
  site: 'Screenshot from the release post',
  iwd: "The map's own loading screen",
  stock: "WaW's loading screen",
  placeholder: '',   // the generated card says NO SCREENSHOT ON FILE on its own face
}

export function MapBody({ mapKey: key }) {
  const { signedIn, approved } = useSession()
  const R = useRail()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [version, setVersion] = useState(null)
  const [shot, setShot] = useState('art')

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
  const f = m.features
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
          <div className="mapdash-credit">
            {shot === 'loadscreen' ? "The map's own loading screen" : (PICTURE[m.art_source] || '')}
          </div>
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
              {m.author
                ? <Link className="mapdash-by" to={`/creator/${encodeURIComponent(m.author)}`} title={`Created by ${m.author}`}>Created by {m.author}</Link>
                : <span>Creator unknown</span>}
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
            {d.live.length > 0 && (
              <div className="mapdash-live"><i aria-hidden="true" />{d.live.length} {d.live.length === 1 ? 'game' : 'games'} on this map now</div>
            )}
            {err && <div className="playbtn-note hot">{err}</div>}
          </div>
        </div>
      </div>

      {f && <Features f={f} />}
      {m.guides && m.guides.length > 0 && <Guides key={m.key} mapKey={m.key} guides={m.guides} />}

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
              {m.readme && <pre className="block" style={{ whiteSpace: 'pre-wrap' }}>{m.readme}</pre>}
            </div>
          </Section>

          <Section title="Records">
            <Boards boards={d.boards} />
          </Section>

          <Section title="Recent games">
            {d.recent.length === 0 ? <Empty>No games yet.</Empty> : (
              // A table, not `.maprow`: that class became the home page's scrolling row of
              // cards in §11, and these rows had been quietly wearing its margins since.
              <div className="listing">
                <table className="data">
                  <tbody>
                    {d.recent.map((g) => (
                      <tr key={g.id}>
                        <td className="num" style={{ width: 70 }}><Link to={`/game/${g.match_id}`}><b>R{g.rounds}</b></Link></td>
                        <td>{g.players.map((p) => p.name).join(', ')}</td>
                        <td>{g.mode === 'local' || g.self_reported ? <Untracked /> : <span className="tag">{g.mode}</span>}</td>
                        <td className="tiny">{g.finish && g.finish.label !== `Round ${g.rounds}` ? g.finish.label : ''}</td>
                        <td className="tiny num">{ago(g.ended_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="What counts as beating it">
            {d.map.finishes.length === 0 ? <Empty>Round {m.round_n || 20}, the default.</Empty> : (
              <div className="card pad-0">
                <table className="data">
                  <thead><tr><th>Finish</th><th className="num">Priority</th><th>Solo</th></tr></thead>
                  <tbody>
                    {d.map.finishes.map((x) => (
                      <tr key={x.id}>
                        <td>{x.label}</td>
                        <td className="num">{x.priority}</td>
                        <td>{x.solo_ok ? 'yes' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.map.signals.length > 0 && (
                  <div className="row wrap" style={{ gap: 5, padding: '10px 14px' }}>
                    <span className="tiny">Also watched</span>
                    {d.map.signals.map((s) => <span className="tag" key={s.id}>{s.label}</span>)}
                  </div>
                )}
              </div>
            )}
          </Section>

          {(d.sources && d.sources.length > 0) || (d.map.files && d.map.files.some((x) => x.kind === 'original')) ? (
            <Section title="Download" right={dl.links ? <span className="tiny">{dl.links_alive} of {dl.links} links alive</span> : null}>
              {d.map.files && d.map.files.filter((x) => x.kind === 'original').map((x) => (
                <div className="card" key={x.path} style={{ marginBottom: 8 }}>
                  <div className="spread">
                    <div className="mono tiny">{x.path}</div>
                    <span className="tag good">Archived</span>
                  </div>
                  <div className="tiny">{x.size ? `${mb(x.size)} · ` : ''}sha256 <code>{x.sha256}</code></div>
                </div>
              ))}
              {d.sources && d.sources.length > 0 && (
                <div className="listing">
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
              )}
            </Section>
          ) : null}

          {d.map.versions.length > 1 && (
            <Section title="Versions">
              <select value={version || d.map.version_id} onChange={(e) => setVersion(Number(e.target.value))} style={{ maxWidth: 260 }}>
                {d.map.versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.latest ? ' (latest)' : ''}</option>)}
              </select>
            </Section>
          )}
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
    </div>
    </div>
  )
}

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

// ---- what is in it -----------------------------------------------------------------------
// One tile per fact, and only the facts the map's files state. A "no" is printed where it is
// information a player asks about (no Pack-a-Punch, no perks on Nacht); a zero count of
// something nobody expects (teleporters) is left off rather than printed as a dash.
function Features({ f }) {
  const wonder = (f.wonder_weapons || []).filter((w) => w !== 'Monkey Bombs')
  const monkeys = (f.wonder_weapons || []).includes('Monkey Bombs')
  const perkCount = (f.perks || []).length + (f.other_perks || 0)
  const tiles = [
    {
      k: 'Perks',
      v: perkCount ? String(perkCount) : 'None',
      s: perkCount ? [...(f.perks || []), f.other_perks ? `+${f.other_perks} custom` : null].filter(Boolean).join(', ') : 'no perk machines',
      off: !perkCount,
    },
    { k: 'Pack-a-Punch', v: f.pack_a_punch ? 'Yes' : 'No', s: f.pack_a_punch ? 'upgrade machine on the map' : 'no upgrade machine', off: !f.pack_a_punch },
    { k: 'Mystery Box', v: f.box ? String(f.box) : 'None', s: f.box > 1 ? 'locations, it moves' : f.box === 1 ? 'location, it stays' : 'no box', off: !f.box },
    { k: 'Wall weapons', v: String(f.wall_weapons || 0), s: 'chalk buys', off: !f.wall_weapons },
    { k: 'Wonder weapons', v: wonder.length ? String(wonder.length) : 'None', s: wonder.join(', ') || 'none in the box', off: !wonder.length },
    { k: 'Hellhounds', v: f.dogs ? 'Yes' : 'No', s: f.dogs ? 'dog rounds' : 'no dog rounds', off: !f.dogs },
    { k: 'Power', v: f.power_switch ? 'Switch' : 'Always on', s: f.power_switch ? 'turn it on first' : 'no power switch' },
    f.traps ? { k: 'Traps', v: 'Yes', s: 'electric / placed traps' } : null,
    f.teleporters ? { k: 'Teleporters', v: String(f.teleporters), s: 'pads to link' } : null,
    monkeys ? { k: 'Equipment', v: 'Monkeys', s: 'Cymbal Monkey in the box' } : null,
  ].filter(Boolean)
  return (
    <section className="mapdash-feats" aria-label="What is in this map">
      <div className="mapdash-feats-head">
        <div className="section-label">What's in it</div>
        <span className="tiny">Read from the map's own files</span>
      </div>
      <div className="mdfeat-grid">
        {tiles.map((t) => (
          <div className={'mdfeat' + (t.off ? ' off' : '')} key={t.k}>
            <div className="mdfig-k">{t.k}</div>
            <div className="mdfeat-v">{t.v}</div>
            <div className="mdfeat-s" title={t.s}>{t.s}</div>
          </div>
        ))}
      </div>
    </section>
  )
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

// Board order and the empty ones.
//
// Every map carries the four ZWR challenge brackets (No Power, No Perks, No Jug, First
// Room) as well as its own categories, and on a map nobody has run yet that is six boards
// all empty. So: the headline boards render in full, and empty challenge brackets collapse
// to one line that still names them.
const ORDER = ['round', 'ee_speedrun', 'buyable_speedrun', 'no_power', 'no_perks', 'no_jug', 'first_room']
const CHALLENGE = new Set(['no_power', 'no_perks', 'no_jug', 'first_room'])
const hasRuns = (b) => b.counts.some((c) => c.rows.length)

function Boards({ boards }) {
  const [pick, setPick] = useState(null)
  if (!boards.length) return <Empty>No records yet.</Empty>
  const sorted = [...boards].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category))
  const shown = sorted.filter((b) => !CHALLENGE.has(b.category) || hasRuns(b))
  const emptyChallenges = sorted.filter((b) => CHALLENGE.has(b.category) && !hasRuns(b))
  const cur = shown.find((b) => b.category === pick) || shown[0]
  return (
    <>
      {shown.length > 1 && (
        <div className="mdboards" role="tablist" aria-label="Which board">
          {shown.map((b) => (
            <button key={b.category} role="tab" aria-selected={cur === b} className={'mdboard' + (cur === b ? ' on' : '')} onClick={() => setPick(b.category)}>
              {b.label}
            </button>
          ))}
        </div>
      )}
      {cur && <Board key={cur.category} board={cur} />}
      {emptyChallenges.length > 0 && (
        <p className="tiny" style={{ marginTop: 8 }}>Open challenges: {emptyChallenges.map((b) => b.label).join(', ')}.</p>
      )}
    </>
  )
}

function Board({ board }) {
  const [pc, setPc] = useState(board.counts.find((c) => c.rows.length)?.player_count ?? 1)
  const sel = board.counts.find((c) => c.player_count === pc) || board.counts[0]
  const time = board.sort === 'time_asc'
  return (
    <div className="mds-board">
      <div className="spread" style={{ marginBottom: 8 }}>
        <div className="section-label">{board.label}</div>
        <div className="mdscope">
          {board.counts.map((c) => (
            <button key={c.player_count} className={'mdscope-b' + (c.player_count === pc ? ' on' : '')} onClick={() => setPc(c.player_count)}>
              {c.player_count === 1 ? 'Solo' : `${c.player_count}p`}
            </button>
          ))}
        </div>
      </div>
      <div className="listing">
        {!sel || sel.rows.length === 0 ? <Empty>No runs yet.</Empty> : (
          <table className="data">
            <thead><tr><th className="num">#</th><th>Players</th><th className="num">{time ? 'Time' : 'Round'}</th><th /></tr></thead>
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
    </div>
  )
}
