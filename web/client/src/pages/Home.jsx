import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ago, num } from '../api'
import { useSession } from '../session'
import { Section, Empty, FinishChips, PlayerLink, Hex, Lockup } from '../components/Bits'
import MapCard from '../components/MapCard'

// Home, top to bottom in the order 13 §3 gives:
//   live games + friends online · map of the week + featured · latest records + badges
//
// And the thing that is NOT here: a rescued counter. 13 §3 is explicit — "No 'rescued'
// counter anywhere in v1." The Maps page shows the list and the number of maps the way
// Movement does, and the archive story gets its own page later.

export default function Home() {
  const [d, setD] = useState(null)
  const { signedIn } = useSession()

  useEffect(() => {
    const load = () => api.get('/api/home').then(setD).catch(() => {})
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [])

  if (!d) return <div className="page"><p className="sub">Loading.</p></div>

  return (
    <div className="page">
      {!signedIn && (
        <section className="card" style={{ marginBottom: 26, display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <Lockup h={54} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <h1 style={{ marginBottom: 6 }}>Every World at War custom zombies map, archived and playable.</h1>
            <p className="sub" style={{ margin: '0 0 12px' }}>
              {num(d.map_count)} maps so far. One click to play with friends on our servers, which referee
              the rounds, the Easter eggs and the endings so the records mean something.
            </p>
            <div className="row">
              <a className="btn primary" href="/auth/mock">Sign in</a>
              <Link className="btn" to="/maps">Browse the maps</Link>
            </div>
          </div>
        </section>
      )}

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <Section title="Live games" sub={`${d.online.online} online`} right={<Link className="btn small ghost" to="/live">Watch</Link>}>
          {d.live.length === 0 ? <Empty>No games running right now.</Empty> : (
            <div className="card flat">
              {d.live.map((g) => {
                // A game that is sending live frames can be watched; one that has only been
                // leased cannot yet, and saying "Watch" for it would be a lie.
                const watch = (d.watchable || []).find((w) => w.match_id === g.match_id)
                return (
                  <div className="maprow" key={g.match_id}>
                    <div className="name">
                      {/* Movement's joinability rule: a stranger's private lobby serialises
                          with no map and no connect, so there is nothing here to render. */}
                      <b>{(watch && watch.map_title) || g.map_title || 'Private lobby'}</b>
                      <span>{g.mode}{watch ? ` · round ${watch.round}` : g.state === 'live' ? ' · live' : ''}</span>
                    </div>
                    <span className="chip">{g.player_count}/4</span>
                    <span className="tiny">{ago(g.started_at)}</span>
                    <span className="row" style={{ gap: 5 }}>
                      {watch && <Link className="btn small ghost" to={`/live/${g.match_id}`}>Watch</Link>}
                      {g.joinable && g.map ? <Link className="btn small" to={`/m/${g.map}`}>Join</Link> : !watch && <span className="tiny">{g.visibility}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Section>

        <Section title="Friends online">
          {!signedIn ? <Empty>Sign in to see your friends.</Empty>
            : d.friends.length === 0 ? <Empty>Nobody you know is online.</Empty> : (
              <div className="card flat">
                {d.friends.map((f) => (
                  <div className="maprow" key={f.steam_id}>
                    <div className="name"><PlayerLink user={f} /></div>
                    <span />
                    <span className="tiny">
                      {f.where.state === 'in-game' ? `playing ${f.where.map_title || ''}` : f.where.state === 'in-party' ? 'in a party' : 'online'}
                    </span>
                    <span />
                  </div>
                ))}
              </div>
            )}
        </Section>
      </div>

      {d.week && (
        <Section title="Map of the week" sub={d.week.note || ''}>
          <div className="grid c2" style={{ alignItems: 'start' }}>
            <MapCard map={d.week.map} big />
            <div className="card">
              <div className="eyebrow">This week&rsquo;s runs</div>
              {d.week.runs.length === 0 ? <Empty>Nobody has played it this week yet.</Empty> : (
                <table className="data">
                  <tbody>
                    {d.week.runs.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td className="rank num">{i + 1}</td>
                        <td><PlayerLink user={r.player} avatar={false} /></td>
                        <td className="num">Round {r.rounds}</td>
                        <td className="tiny">{r.finish === 'easter_egg' ? 'Easter Egg' : r.finish === 'buyable_ending' ? 'Buyable Ending' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </Section>
      )}

      <Section title="Featured" right={<Link className="btn small ghost" to="/maps">All {num(d.map_count)} maps</Link>}>
        <div className="grid c4">{d.featured.map((m) => <MapCard key={m.key} map={m} />)}</div>
      </Section>

      <Section title="Latest">
        {d.feed.length === 0 ? <Empty>Nothing has happened yet.</Empty> : (
          <div className="card">
            {d.feed.map((f) => (
              <div className="feedline" key={f.id}>
                {f.badge ? <Hex badge={f.badge} size={26} /> : null}
                <span>
                  {f.player ? <PlayerLink user={f.player} avatar={false} /> : null}{' '}
                  {f.kind === 'badge' ? <span className="sub">{f.text}</span>
                    : f.kind === 'record' ? <span className="gold">{f.text}</span>
                      : <span className="sub">{f.text}</span>}
                  {f.map && f.kind === 'finish' ? null : null}
                </span>
                <span className="when">{ago(f.at)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="tiny" style={{ paddingBottom: 30 }}>
        <FinishChips map={{ has_ee: false, has_buyable: false, round_n: 20 }} />{' '}
        is the default finish on a map with no Easter egg and no buyable ending.
      </div>
    </div>
  )
}
