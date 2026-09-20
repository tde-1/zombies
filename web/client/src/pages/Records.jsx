import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ago, clock } from '../api'
import { Section, Empty, PlayerLink } from '../components/Bits'

// The records hub (13 §3, like Movement's /records): world records across every map and
// category. Boards live on the map pages too; this is the cross-map view.
//
// The rule profile is a FILTER, not a footnote. A run is checked against a named profile
// (ENW-Verified, ZWR, speedrun.com) and the mismatch is shown rather than the run hidden —
// vault 10's rule — so the profile selector is the first control on the page.

export default function Records() {
  const [d, setD] = useState(null)
  const [category, setCategory] = useState('')
  const [players, setPlayers] = useState('')
  const [profile, setProfile] = useState('ENW-Verified')

  useEffect(() => {
    const qs = new URLSearchParams()
    if (category) qs.set('category', category)
    if (players) qs.set('players', players)
    qs.set('profile', profile)
    api.get(`/api/records?${qs}`).then(setD).catch(() => {})
  }, [category, players, profile])

  if (!d) return <div className="page"><p className="sub">Loading.</p></div>
  const prof = d.profiles.find((p) => p.key === profile)

  return (
    <div className="page wide">
      <Section title="Records" sub={prof ? prof.note : ''}>
        <div className="filters">
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {d.profiles.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Every category</option>
            {d.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <select value={players} onChange={(e) => setPlayers(e.target.value)}>
            <option value="">Any player count</option>
            <option value="1">Solo</option>
            <option value="2">2 players</option>
            <option value="3">3 players</option>
            <option value="4">4 players</option>
          </select>
        </div>

        {d.records.length === 0 ? <Empty>No records on this board yet.</Empty> : (
          <div className="card">
            <table className="data">
              <thead>
                <tr><th>Map</th><th>Category</th><th>Players</th><th>Holder</th><th className="num">Result</th><th></th><th></th></tr>
              </thead>
              <tbody>
                {d.records.map((r) => (
                  <tr key={r.board_id}>
                    <td><Link to={`/m/${r.map_key}`}>{r.map_title}</Link></td>
                    <td className="tiny">{r.label}</td>
                    <td className="tiny">{r.player_count === 1 ? 'Solo' : `${r.player_count}p`}</td>
                    <td>{r.top.players.map((p) => <PlayerLink key={p.steam_id} user={p} avatar={false} />).reduce((a, b) => [a, ', ', b])}</td>
                    <td className="num gold">{r.sort === 'time_asc' ? clock(r.top.value_ms) : `Round ${r.top.round}`}</td>
                    <td className="tiny">{r.top.profile_ok ? '' : <span className="hot" title={r.top.profile_note}>rules mismatch</span>}</td>
                    <td className="tiny">{ago(r.top.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="tiny" style={{ marginTop: 12 }}>
          Every run on these boards was refereed on our own servers and has a signed replay behind it.
          A world record does not need video; video is optional.
        </p>
      </Section>
    </div>
  )
}
