import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, clock } from '../api'
import { useSession } from '../session'
import { Loading } from '../components/Bits'
import MapBanner from '../components/MapBanner'
import ProfileComments from '../components/ProfileComments'
import BadgeShelf, { BadgePins } from '../components/BadgeShelf'
import WatchButton from '../components/WatchButton'
import { setAmbienceOverride } from '../ambience'
import { mapHue, prettyTitle } from '../data/mapText'
import '../profile.css'

// Profile — ENW MOVEMENT'S, copied (B, 2026-09-22: "Copy exactly the profile from ENW Movement,
// with the comments and the banner and everything … No featured skins (this is not CS:GO). A
// separate comment section. Recent maps and top maps at the top like Movement, showing the
// zombies maps they play, with the map images and the time spent. And another section with
// overall stats.")
//
// The source is CSGO-Matchmaker/movement-client/src/pages/Profile.jsx. Its shape is kept piece
// for piece, and the names of the pieces are its names:
//
//   THE HEADER is one object: the banner, and fused to its bottom edge the identity bar — the
//   picture punching up through the seam with its presence dot, the name (a link to Steam), the
//   country code, the VIP and role tags, the tagline, the worn badges, and the stat strip.
//
//   LEFT is the sticky rail: the badge shelf and the facts that never change.
//
//   RIGHT is what they have done: "Top maps" and "Recent maps" side by side (Movement's Most
//   played / Recently played — the same map-art rows), then Overall, then the records they hold,
//   then the comment wall, last, Steam-style.
//
// WHAT CAME OFF, AND WHY
//   * The drops.ws skins on the banner. B: this is not CS:GO.
//   * The rank rail and its five-board mode selector, the KZ global band, the PB browser and
//     its tier bars, the HUD card. Zombies has one board and no timer ladder; the zombies facts
//     those stood for are Top/Recent maps and Overall.
//   * The banner UPLOAD and its crop dialog. The banner is the one set on ENW Movement, copied
//     here (server/lib/movementProfile.js) so it is the same picture on Movement, drops.ws and
//     here. A second upload on this site would be a fourth banner that disagrees. On your own
//     profile the button says where to change it.
//   * Movement's UID fact (a Movement purchase number) and the friend-request toast.
//
// THE BANNER, when there is none on Movement, is the map this player has spent the most time on
// (Movement's auto-banner, owner 2026-08-28), named on the art so it reads as the site's choice.

const MAP_ROWS = 5

// ── formatting helpers (Movement's) ───────────────────────────────────────────
function ago(ms) {
  if (!ms) return ''
  const secs = Math.max(0, (Date.now() - Number(ms)) / 1000)
  if (secs < 90) return 'just now'
  const mins = secs / 60
  if (mins < 60) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 24) return `${Math.round(hrs)}h ago`
  const days = hrs / 24
  if (days < 31) return `${Math.round(days)}d ago`
  const months = days / 30.44
  if (months < 12) return `${Math.round(months)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}
// Total time on the clock, in the biggest sensible unit ("18h 40m", "4d 3h").
function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
function fmtDate(ms) {
  const d = new Date(Number(ms))
  return !ms || Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}
const nf = (n) => (Number(n) || 0).toLocaleString()
const plural = (n, one, many) => `${nf(n)} ${Number(n) === 1 ? one : many}`

// The two-letter code itself, set as type beside the name. No flag pictograph stands in for it.
function countryCode(cc) {
  const c = String(cc || '').toUpperCase()
  return /^[A-Z]{2}$/.test(c) ? c : null
}
function countryName(cc) {
  const c = countryCode(cc)
  if (!c) return null
  try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(c) || c } catch (e) { return c }
}

const mapTitle = (m) => prettyTitle(m.title, m.key)
const artOf = (m) => ({ banner: m.art || null, bannerLarge: null, hue: mapHue(m.key) })

export default function Profile() {
  const { who } = useParams()
  const { me, refresh } = useSession()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    return api.get(`/api/players/${encodeURIComponent(who)}`).then(setD).catch((e) => setErr(e.status === 404 ? 'missing' : e.message))
  }, [who])

  useEffect(() => { setD(null); setErr(null); load() }, [load])

  // ── the room this profile is lit in ──────────────────────────────────────────
  // Movement pours the banner (or the auto-banner's map) over the whole site while you are on a
  // profile, and hands the ambience back on the way out. Ours takes the same { key, art } source
  // a map row is.
  const banner = d && d.movement && d.movement.banner
  const top = d && d.maps && d.maps.top && d.maps.top[0]
  const autoMap = !banner && top ? top : null
  useEffect(() => {
    if (banner) setAmbienceOverride({ key: `banner:${banner}`, art: banner })
    else if (autoMap && autoMap.art) setAmbienceOverride({ key: autoMap.key, art: autoMap.art })
    else setAmbienceOverride(null)
    return () => setAmbienceOverride(null)
  }, [banner, autoMap && autoMap.key, autoMap && autoMap.art])

  if (err === 'missing') return <div className="page"><div className="empty" style={{ marginTop: 24 }}>No such player on ENW Zombies.</div></div>
  if (err) return <div className="page"><div className="empty" style={{ marginTop: 24 }}>This profile could not be loaded.</div></div>
  if (!d) return <div className="page"><Loading /></div>

  const p = d.player
  const isSelf = !!(me && me.steam_id === p.steam_id)
  const name = p.name
  const badges = { all: d.badges || [], pinned: d.pinned || [], max_pinned: 3 }
  const reloadProfile = () => { load(); refresh() }

  return (
    <div className="page wide">
      <div className="prof-page">
        <div className="prof-head">
          <ProfileBanner
            user={p} isSelf={isSelf} name={name} movement={d.movement} autoMap={autoMap}
            friendState={d.friend_state} signedIn={!!me} who={who} onFriendship={reloadProfile}
          />
          <IdentityBar
            user={p} name={name} isSelf={isSelf} where={d.where} movement={d.movement}
            topMap={top} overall={d.overall} badges={badges} onBadgesChanged={reloadProfile}
          />
        </div>

        <div className="prof-grid">
          <ProfileRail user={p} isSelf={isSelf} badges={badges} standing={d.standing}
                       onBadgesChanged={reloadProfile} />

          <div className="prof-main">
            {/* where the time went comes FIRST (Movement's order): the maps someone lives on say
                more about them than any other list on the page. History privacy hides these two
                and nothing else — records and badges are always public (99 §4.1). */}
            {d.history_hidden ? (
              <section className="prof-section">
                <div className="card prof-card"><div className="empty">History is private.</div></div>
              </section>
            ) : (
              <div className="prof-split">
                <PlayedMaps title="Most played" rows={(d.maps && d.maps.top) || []} />
                <PlayedMaps title="Recently played" rows={(d.maps && d.maps.recent) || []} recency />
              </div>
            )}

            {/* Movement's order: the maps, then the records. */}
            {d.records && d.records.length > 0 && <RecordsHeld rows={d.records} />}

            <Overall o={d.overall} />

            {/* The wall goes LAST, Steam-style: it is the thing you scroll to the bottom for. */}
            <ProfileComments profileId={p.steam_id} me={me} ownerName={name} />

            {isSelf && <div id="settings"><OwnSettings onSaved={reloadProfile} /></div>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── the banner ────────────────────────────────────────────────────────────────
// Full width, above the two columns, with the share link and the friend action top-right. On
// your own profile the top-right also says where the banner is changed: on ENW Movement.
function CopyProfileLink({ name }) {
  const url = name ? `${location.origin}/id/${encodeURIComponent(name)}` : null
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return undefined
    const t = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(t)
  }, [done])
  if (!url) return null
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setDone(true) } catch (e) { window.prompt('Copy the link', url) }
  }
  return (
    <button type="button" className="btn btn-ghost btn-sm prof-copy" onClick={copy} title={url}>
      {done ? 'Copied' : 'Copy link'}
    </button>
  )
}

function ProfileBanner({ user, isSelf, name, movement, autoMap, friendState, signedIn, who, onFriendship }) {
  const mv = movement || {}
  const banner = mv.banner || null
  const pos = mv.banner_pos != null ? mv.banner_pos : 50
  const showAuto = !banner && !!autoMap
  return (
    <div className={'prof-cover' + (banner || showAuto ? '' : ' prof-cover-empty')}>
      {banner
        ? <img className="prof-cover-img" src={banner} alt="" style={{ objectPosition: `50% ${pos}%` }} />
        : showAuto
          ? <MapBanner map={artOf(autoMap)} />
          : <div className="prof-cover-wash" />}
      <div className="prof-cover-veil" />
      {showAuto && <span className="prof-cover-autotag">{mapTitle(autoMap)}</span>}

      <div className="prof-cover-tr">
        <CopyProfileLink name={name} />
        {isSelf && mv.profile_url && (
          <a className="btn btn-ghost btn-sm" href={mv.profile_url} target="_blank" rel="noopener noreferrer"
             title="Your banner comes from ENW Movement">
            {banner ? 'Change banner on Movement' : 'Add a banner on Movement'}
          </a>
        )}
        {!isSelf && signedIn && (
          <FriendButton name={name} state={friendState} who={who} onChanged={onFriendship} />
        )}
      </div>
    </div>
  )
}

// ── the identity bar ──────────────────────────────────────────────────────────
// Full width, fused to the bottom of the cover. The picture punching up through the seam, the
// name and what they are known for, the badges they wear, and the headline figures. Like
// Movement's, a figure a player HOLDS (a record) is only printed when they hold one.
function IdentityBar({ user, name, isSelf, where, movement, topMap, overall, badges, onBadgesChanged }) {
  const flag = countryCode(movement && movement.country)
  const o = overall || {}
  // A figure with no value is left out, never dashed (Movement hides WRs and podiums at 0;
  // here every cell follows that rule).
  const cells = [
    ...(o.games > 0 ? [{ k: 'Games', v: nf(o.games) }] : []),
    ...(o.best_round ? [{ k: 'Best round', v: nf(o.best_round.round) }] : []),
    ...(o.records_held > 0 ? [{ k: 'Records', v: nf(o.records_held), gold: true }] : []),
    ...(o.time_ms > 0 ? [{ k: 'Time played', v: fmtDuration(o.time_ms) }] : []),
  ]
  return (
    <div className="prof-idbar">
      <span className="prof-av-wrap">
        {user.avatar
          ? <img src={user.avatar} alt="" className="prof-av" />
          : <span className="avatar prof-av">{String(name || '?').slice(0, 1).toUpperCase()}</span>}
        <PresenceDot where={where} />
      </span>

      <div className="prof-ident">
        {/* The NAME is the way to Steam (Movement, owner 2026-08-05). */}
        <h1 className="prof-name">
          <a className="prof-name-link" href={`https://steamcommunity.com/profiles/${user.steam_id}`}
             target="_blank" rel="noopener noreferrer" title={`${name} on Steam`}>{name}</a>
          {flag && <span className="prof-flag" title={countryName(flag) || undefined}>{flag}</span>}
          {user.vip && <span className="tag gold prof-vip">VIP</span>}
          {user.admin && <span className="tag prof-role">Admin</span>}
          {user.mod && !user.admin && <span className="tag prof-role">Mod</span>}
          {user.archivist && <span className="tag prof-role">Archivist</span>}
        </h1>
        {/* The tagline says ONE thing: the map this player is known for, off the clock. */}
        {topMap && (
          <div className="prof-tagline">
            <span className="prof-tag-k">Most played:</span>{' '}<b>{mapTitle(topMap)}</b>
          </div>
        )}
      </div>

      <BadgePins badges={badges} isSelf={isSelf} onChanged={onBadgesChanged} />

      {cells.length > 0 && (
        <div className={'prof-stats' + (cells.length === 4 ? ' is-four' : '')}>
          {cells.map((c) => (
            <div className="prof-stat" key={c.k}>
              <div className="prof-stat-k">{c.k}</div>
              <div className={'prof-stat-v' + (c.gold ? ' gold' : '')}>{c.v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── presence: a dot on the avatar ─────────────────────────────────────────────
// On the site, in a party or in a game: here now. NOTHING when they're away. The map they are
// on is in the tooltip.
function PresenceDot({ where }) {
  if (!where) return null
  const label = where.state === 'in-game' ? `In game${where.map_title ? ' · ' + where.map_title : ''}`
    : where.state === 'in-party' ? 'In a party' : 'Online'
  return <span className="prof-av-dot" title={label} aria-label={label} role="img" />
}

// ── the rail: badges and the facts ────────────────────────────────────────────
function ProfileRail({ user, isSelf, badges, standing, onBadgesChanged }) {
  const s = standing || {}
  return (
    <aside className="prof-rail">
      <div className="prof-rail-card">
        <BadgeShelf badges={badges} isSelf={isSelf} onChanged={onBadgesChanged} />

        <div className="prof-rail-facts">
          {user.created_at && (
            <div className="prof-fact">
              <span className="prof-fact-k">Date registered</span>
              <span className="prof-fact-v">{fmtDate(user.created_at)}</span>
            </div>
          )}
          {/* Zombies' XP level (05): active time, Verified full, Custom a quarter, Local none. */}
          {s.level != null && (
            <div className="prof-fact">
              <span className="prof-fact-k">Level</span>
              <span className="prof-fact-v">{s.prestige > 0 && s.emblem ? `${s.emblem.label} · ` : ''}{nf(s.level)}</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

// ── friend button (Movement's, on our friend states) ──────────────────────────
function FriendButton({ name, state, who, onChanged }) {
  const [busy, setBusy] = useState(false)
  const run = async (action) => {
    if (busy) return
    setBusy(true)
    try { await api.post(`/api/players/${encodeURIComponent(who)}/friend`, { action }); onChanged() }
    catch (e) { window.alert(e.message) } finally { setBusy(false) }
  }
  if (state === 'friends') {
    return (
      <button className="btn btn-sm prof-ident-act friend-btn is-friend" disabled={busy}
        title={`Remove ${name} from your friends`}
        onClick={() => { if (window.confirm(`Remove ${name} from your friends?`)) run('remove') }}>
        <span className="friend-btn-on">Friends</span>
        <span className="friend-btn-off">Unfriend</span>
      </button>
    )
  }
  if (state === 'incoming') {
    return (
      <button className="btn btn-sm btn-accent prof-ident-act friend-btn" disabled={busy}
        title={`${name} sent you a friend request`} onClick={() => run('accept')}>
        {busy ? '…' : 'Accept request'}
      </button>
    )
  }
  if (state === 'sent') {
    return (
      <button className="btn btn-sm prof-ident-act friend-btn is-pending" disabled={busy}
        title="Cancel your friend request" onClick={() => run('remove')}>
        <span className="friend-btn-on">Requested</span>
        <span className="friend-btn-off">Cancel</span>
      </button>
    )
  }
  return (
    <button className="btn btn-sm prof-ident-act friend-btn" disabled={busy}
      title={`Add ${name} as a friend`} onClick={() => run('request')}>
      {busy ? '…' : 'Add friend'}
    </button>
  )
}

// ── played maps: where the time actually went ─────────────────────────────────
// Movement's rows: a fixed band, the map's art covering it, a left-weighted scrim so the type
// stays readable. Art comes through <MapBanner>, so a map with no picture degrades to its own
// hue wash — never a broken image. Each row carries the zombies facts B asked for: the time
// spent (right), and the games and best round (sub-line); "Recently played" adds when.
function PlayedMaps({ title, rows, recency }) {
  return (
    <section className="prof-section">
      <div className="prof-section-head">
        <div className="section-label">{title}</div>
      </div>
      <div className="card prof-card">
        {rows.length === 0
          ? <div className="empty">No games yet.</div>
          : <div className="pm-list">
              {rows.slice(0, MAP_ROWS).map((r) => (
                <Link className="pm-row" key={r.key} to={`/m/${r.key}`} title={mapTitle(r)}>
                  <MapBanner map={artOf(r)} />
                  <span className="pm-scrim" aria-hidden="true" />
                  <span className="pm-main">
                    <span className="pm-name">{mapTitle(r)}</span>
                    <span className="pm-sub pm-bits">
                      <span>{plural(r.games, 'game', 'games')}</span>
                      {r.best_round > 0 && <span>best round {nf(r.best_round)}</span>}
                      {recency && r.last_played && <span>{ago(r.last_played)}</span>}
                    </span>
                  </span>
                  {r.time_ms > 0 && <span className="pm-dur">{fmtDuration(r.time_ms)}</span>}
                </Link>
              ))}
            </div>}
      </div>
    </section>
  )
}

// ── Overall ───────────────────────────────────────────────────────────────────
// B's section: the career in one card. Only what has a value is printed — no dashes, no
// zeros. Kills, downs and revives arrive null from the server until the game records them
// (server/lib/profile.js), and are hidden until then. Time played, records and the join date
// are already in the identity bar and the rail, so they are not repeated here.
function Overall({ o }) {
  if (!o) return null
  const b = o.best_round
  const has = (n) => n != null && Number(n) > 0
  const cells = [
    ...(has(o.games) ? [{ k: 'Games', v: nf(o.games) }] : []),
    ...(has(o.rounds_played) ? [{ k: 'Rounds', v: nf(o.rounds_played) }] : []),
    ...(b ? [{
      k: 'Best round',
      v: nf(b.round),
      sub: (
        <>
          <Link to={`/game/${b.match_id}`}>{prettyTitle(b.map_title, b.map_key)}</Link>
          <WatchButton matchId={b.match_id} replay={b.replay} className="prof-watch" />
        </>
      ),
    }] : []),
    ...(has(o.kills) ? [{ k: 'Kills', v: nf(o.kills) }] : []),
    ...(has(o.downs) ? [{ k: 'Downs', v: nf(o.downs) }] : []),
    ...(has(o.revives) ? [{ k: 'Revives', v: nf(o.revives) }] : []),
  ]
  if (!cells.length) return null
  return (
    <section className="prof-section">
      <div className="prof-section-head">
        <div className="section-label">Overall</div>
      </div>
      <div className="card prof-card">
        <div className="prof-overall">
          {cells.map((c) => (
            <div className="prof-stat" key={c.k}>
              <div className="prof-stat-k">{c.k}</div>
              <div className={'prof-stat-v' + (c.gold ? ' gold' : '')}>{c.v}</div>
              {c.sub && <div className="prof-stat-sub">{c.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── records held ──────────────────────────────────────────────────────────────
// Movement's RecordCard: the played-map card, and the Watch button BESIDE the link rather than
// inside it (`.rec-cell` > `.pm-row` + `.rec-watch`), so Watch opens the replay and the rest of
// the row opens the map. The figure is the round, gold, or the time for a speedrun category.
function RecordsHeld({ rows }) {
  return (
    <section className="prof-section">
      <div className="prof-section-head">
        <div className="section-label">Records</div>
        <span className="muted small">{nf(rows.length)}</span>
      </div>
      <div className="card prof-card">
        <div className="pm-list">
          {rows.map((r, i) => (
            <div className="rec-cell" key={i}>
              <Link className="pm-row" to={`/m/${r.map_key}`}>
                <MapBanner map={artOf({ key: r.map_key, art: r.art })} />
                <span className="pm-scrim" aria-hidden="true" />
                <span className="pm-main">
                  <span className="pm-name">{prettyTitle(r.map_title, r.map_key)}</span>
                  <span className="pm-sub pm-bits">
                    <span>{r.label}</span>
                    <span>{r.player_count === 1 ? 'solo' : `${r.player_count}p`}</span>
                    {r.at && <span>{ago(r.at)}</span>}
                  </span>
                </span>
                <span className="pm-figs">
                  <span className="pm-time" style={{ color: 'var(--gold)' }}>{r.round ? `Round ${r.round}` : clock(r.value_ms)}</span>
                </span>
              </Link>
              <WatchButton className="rec-watch" matchId={r.match_id} replay={r.replay} label={prettyTitle(r.map_title, r.map_key)} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── your settings (own profile only) ──────────────────────────────────────────
// The two privacy choices a profile has. Game settings live on /settings.
function OwnSettings({ onSaved }) {
  const { session, refresh } = useSession()
  const [err, setErr] = useState(null)
  const u = (session && session.user) || {}
  const put = async (body) => {
    try { await api.put('/api/me/privacy', body); refresh(); onSaved() } catch (e) { setErr(e.message) }
  }
  return (
    <section className="prof-section prof-settings">
      <div className="prof-section-head">
        <div className="section-label">Privacy</div>
        <Link className="muted small" to="/settings">Game settings</Link>
      </div>
      <div className="card prof-card grid c2">
        <label className="field"><span>Played maps</span>
          <select defaultValue={u.privacy_history || 'public'} onChange={(e) => put({ history: e.target.value })}>
            <option value="public">Public</option>
            <option value="private">Hidden</option>
          </select></label>
        <label className="field"><span>Comments</span>
          <select defaultValue={u.profile_comments || 'everyone'} onChange={(e) => put({ profile_comments: e.target.value })}>
            <option value="everyone">Everyone</option>
            <option value="friends">Friends</option>
            <option value="nobody">Nobody</option>
          </select></label>
      </div>
      {err && <p className="tiny hot">{err}</p>}
    </section>
  )
}
