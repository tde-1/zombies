import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ago, dur, hours, num } from '../api'
import { useSession } from '../session'
import { Section, Empty, Avatar, Level, Hex, BadgeTile, PlayerLink } from '../components/Bits'
import Comments from '../components/Comments'

// The profile = Movement's, plus the zombies additions (05, 13 §3):
//   map shelf (greyed until beaten, with ticks) · career stats strip · recent games ·
//   favourite / most played · level + prestige · the VIP tag
//
// Privacy, enforced by the server and rendered honestly here: game history is public by
// default and hideable; RECORDS AND BADGES ARE ALWAYS PUBLIC. So a hidden profile still
// shows its shelf, its badges and its records, and says plainly that the history is hidden.

export default function Profile() {
  const { who } = useParams()
  const { me, signedIn, refresh } = useSession()
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setD(null)
    api.get(`/api/players/${encodeURIComponent(who)}`).then(setD).catch((e) => setErr(e.message))
  }, [who])

  useEffect(() => { load() }, [load])

  if (err) return <div className="page"><h1>{err}</h1></div>
  if (!d) return <div className="page"><p className="sub">Loading.</p></div>

  const p = d.player
  const isSelf = me && me.steam_id === p.steam_id
  const c = d.career

  const friend = async (action) => {
    try { await api.post(`/api/players/${encodeURIComponent(who)}/friend`, { action }); load(); refresh() } catch (e) { setErr(e.message) }
  }

  return (
    <div className="page wide">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <Avatar user={p} size="lg" />
          <div style={{ flex: 1 }}>
            <div className="row" style={{ gap: 9 }}>
              <h1>{p.name}</h1>
              {p.vip && <span className="chip vip">VIP</span>}
              {p.admin && <span className="chip">admin</span>}
              {p.mod && !p.admin && <span className="chip">mod</span>}
              {p.archivist && <span className="chip">archivist</span>}
            </div>
            <div className="row" style={{ gap: 12, marginTop: 6 }}>
              <Level standing={d.standing} showBar />
              <span className="tiny">
                {d.standing.prestige > 0 ? `${d.standing.emblem.label} · ` : ''}level {d.standing.level}
                {d.standing.next_level_cost ? ` · ${num(d.standing.next_level_cost - d.standing.into_level)} xp to the next` : ''}
              </span>
              {d.where && <span className="chip">{d.where.state === 'in-game' ? `playing ${d.where.map_title || ''}` : d.where.state === 'in-party' ? 'in a party' : 'online'}</span>}
            </div>
          </div>
          {signedIn && !isSelf && (
            <div className="stack">
              {d.friend_state === 'none' && <button className="btn small" onClick={() => friend('request')}>Add friend</button>}
              {d.friend_state === 'sent' && <span className="chip">Request sent</span>}
              {d.friend_state === 'incoming' && (
                <div className="row"><button className="btn small accent" onClick={() => friend('accept')}>Accept</button>
                  <button className="btn small ghost" onClick={() => friend('decline')}>Decline</button></div>
              )}
              {d.friend_state === 'friends' && <button className="btn small ghost" onClick={() => friend('remove')}>Friends</button>}
            </div>
          )}
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 22 }}>
        <div className="stat"><span>Maps beaten</span><b className="num">{c.maps_beaten} / {c.maps_total}</b></div>
        <div className="stat"><span>Highest round</span><b className="num">{c.best_round || '—'}</b></div>
        <div className="stat"><span>Easter eggs</span><b className="num">{c.easter_eggs}</b></div>
        <div className="stat"><span>Games</span><b className="num">{num(c.games)}</b></div>
        <div className="stat"><span>Time played</span><b className="num">{hours(c.time_ms)}</b></div>
        <div className="stat"><span>Kills</span><b className="num">{num(c.kills)}</b></div>
        <div className="stat"><span>Downs</span><b className="num">{num(c.downs)}</b></div>
        <div className="stat"><span>Revives</span><b className="num">{num(c.revives)}</b></div>
      </div>

      {d.pinned.length > 0 && (
        <Section title="Pinned">
          <div className="row wrap">{d.pinned.map((b) => <BadgeTile key={b.id} badge={b} />)}</div>
        </Section>
      )}

      <Section title="Map shelf" sub="Every map. Greyed until beaten; gold while they hold the record.">
        <div className="shelf">
          {d.shelf.map((s) => (
            <Link className={`slot ${s.beaten ? 'beaten' : ''}`} key={s.key} to={`/m/${s.key}`}
              title={s.beaten ? `Beaten${s.solo ? ' solo' : ''}${s.best_round ? ` · best round ${s.best_round}` : ''}` : s.played ? `Played · best round ${s.best_round}` : 'Not played'}>
              <Hex label={s.title} code={s.key.replace('nazi_zombie_', '').toUpperCase().slice(0, 9)} size={56} gold={s.gold} locked={!s.beaten} />
              <div className="nm tiny">{s.title}</div>
              <div className="ticks">
                {s.ee ? 'EE ' : ''}{s.buyable ? 'BE ' : ''}{s.best_round ? `R${s.best_round}` : ''}{s.solo ? ' · solo' : ''}
              </div>
            </Link>
          ))}
        </div>
      </Section>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <div>
          <Section title="Recent games">
            {d.history_hidden ? <Empty>This player has hidden their game history. Records and badges stay public.</Empty>
              : !d.recent || d.recent.length === 0 ? <Empty>No games yet.</Empty> : (
                <div className="card flat">
                  {d.recent.map((g) => (
                    <Link className="maprow" key={g.id} to={`/game/${g.match_id}`}>
                      <div className="name"><b>{g.map_title}</b><span>{g.players.map((x) => x.name).join(', ')}</span></div>
                      <span className={`chip ${g.mode === 'local' || g.self_reported ? 'be' : ''}`}
                        title={g.mode === 'local' ? 'Ran on their own PC. Untracked.' : ''}>{g.mode}</span>
                      <span className="num">R{g.rounds}</span>
                      <span className="tiny">{dur(g.duration_ms)} · {ago(g.ended_at)}</span>
                    </Link>
                  ))}
                </div>
              )}
          </Section>

          <Section title="Comments">
            <Comments kind="profile" subject={p.steam_id} initial={d.comments} onChange={load} canComment={d.can_comment} />
          </Section>
        </div>

        <div>
          <Section title="Records held">
            {d.records.length === 0 ? <Empty>None yet.</Empty> : (
              <div className="card">
                <table className="data">
                  <tbody>
                    {d.records.map((r, i) => (
                      <tr key={i}>
                        <td><Link to={`/m/${r.map_key}`}>{r.map_title}</Link></td>
                        <td className="tiny">{r.label} · {r.player_count === 1 ? 'solo' : `${r.player_count}p`}</td>
                        <td className="num gold">{r.round ? `R${r.round}` : dur(r.value_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Badges">
            {d.badges.length === 0 ? <Empty>None yet.</Empty> : (
              <div className="row wrap">{d.badges.map((b) => <BadgeTile key={b.id} badge={b} gold={b.kind === 'record'} />)}</div>
            )}
          </Section>

          <Section title="Most played">
            {d.most_played.length === 0 ? <Empty>Nothing yet.</Empty> : (
              <div className="card">
                <table className="data">
                  <tbody>
                    {d.most_played.map((m) => (
                      <tr key={m.key}><td><Link to={`/m/${m.key}`}>{m.title}</Link></td>
                        <td className="num">{m.games}</td><td className="num tiny">{hours(m.time_ms)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {d.favourites.length > 0 && (
            <Section title="Favourites">
              <div className="row wrap" style={{ gap: 6 }}>
                {d.favourites.map((m) => <Link className="chip" key={m.key} to={`/m/${m.key}`}>{m.title}</Link>)}
              </div>
            </Section>
          )}
        </div>
      </div>

      {isSelf && <Settings d={d} onSaved={load} />}
    </div>
  )
}

function Settings({ d, onSaved }) {
  const { session, refresh } = useSession()
  const [err, setErr] = useState(null)
  const s = (session && session.user && session.user.settings) || {}

  const put = async (path, body) => {
    try { await api.put(path, body); refresh(); onSaved() } catch (e) { setErr(e.message) }
  }

  return (
    <Section title="Your settings" sub="Saved to your account and applied over World at War at launch. Your own config is never modified.">
      <div className="card grid c3">
        <label className="field"><span>FOV (65–120)</span>
          <input type="number" min={65} max={120} defaultValue={s.fov} onBlur={(e) => put('/api/me/settings', { fov: Number(e.target.value) })} /></label>
        <label className="field"><span>Max FPS (20–250)</span>
          <input type="number" min={20} max={250} defaultValue={s.max_fps} onBlur={(e) => put('/api/me/settings', { max_fps: Number(e.target.value) })} /></label>
        <label className="field"><span>Chat channel</span>
          <select defaultValue={s.chat_channel} onChange={(e) => put('/api/me/settings', { chat_channel: e.target.value })}>
            <option value="auto">Auto (solo Global, group Local)</option>
            <option value="local">Local</option>
            <option value="global">Global</option>
          </select></label>
        <label className="field"><span>Game history</span>
          <select defaultValue={session.user.privacy_history} onChange={(e) => put('/api/me/privacy', { history: e.target.value })}>
            <option value="public">Public</option>
            <option value="private">Hidden</option>
          </select></label>
        <label className="field"><span>Who can comment on your profile</span>
          <select defaultValue={session.user.profile_comments} onChange={(e) => put('/api/me/privacy', { profile_comments: e.target.value })}>
            <option value="everyone">Everyone</option>
            <option value="friends">Friends</option>
            <option value="nobody">Nobody</option>
          </select></label>
        <label className="field"><span>Zombie counter</span>
          <select defaultValue={String(!!s.zombie_counter)} onChange={(e) => put('/api/me/settings', { zombie_counter: e.target.value === 'true' })}>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select></label>
      </div>
      <p className="tiny" style={{ marginTop: 8 }}>
        Records and badges are always public and cannot be hidden. The zombie counter is forced off in record games whatever this says.
      </p>
      {err && <p className="tiny hot">{err}</p>}
      {d.badges.length > 0 && <PinPicker badges={d.badges} pinned={d.pinned} />}
    </Section>
  )
}

function PinPicker({ badges, pinned }) {
  const { refresh } = useSession()
  const [ids, setIds] = useState(pinned.map((b) => b.id))
  const toggle = async (id) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-3)
    setIds(next)
    await api.put('/api/me/pinned', { ids: next })
    refresh()
  }
  return (
    <div style={{ marginTop: 14 }}>
      <div className="eyebrow">Pinned badges (up to three)</div>
      <div className="row wrap" style={{ gap: 6 }}>
        {badges.map((b) => (
          <button key={b.id} className={`chip ${ids.includes(b.id) ? 'on' : ''}`} onClick={() => toggle(b.id)}>{b.name}</button>
        ))}
      </div>
    </div>
  )
}
