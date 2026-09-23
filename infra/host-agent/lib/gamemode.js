// A map's own pre-game choice (UGX Mod's game mode vote on Battlestar Galactica and friends),
// picked by the party leader on the site and answered by the server so the menu never shows.
// docs/kickstart/game-modes.md.
//
// The site resolves the party's pick against its catalogue (web/server/data/map-modes.json,
// made by archive/scan_modes.py) and sends the result on the lease as `game_mode`:
//
//     { id: 'gungame', label: 'Gun Game', mechanism: 'ugx_vote_1',
//       hide: ['ugxm_vote_host', 'ugxm_vote_players'], answer_menu: 'ugxm_vote_host',
//       responses: ['gg', 'start'], done: 'ugxm_voting_complete' }
//
// This turns it into ONE host-owned dvar the DLL reads (server/components/game_mode):
//   enw_game_mode  <id>:<hide.hide>:<answer menu>:<resp.resp>[:<done notify>]
// One, not four: the engine keeps at most 31 `+` commands and silently drops the rest, `+map`
// included (menu_answer.hpp; measured). Lists are '.'-separated (a ',' is a separator to some
// launch layers). The name, and the three it replaced, are host-owned in
// the same sense as `dedicated` and `net_port` (instances.js HOST_OWNED_DVARS): a party's
// Custom `settings.dvars` can never set them, and they go on a Verified game's command line
// too, because the mode is the map's own content, not a setting.
//
// Security: every piece is one token of [A-Za-z0-9_], the lists are short, and the answered
// menu must be one of the hidden ones. Anything else and NONE of it is passed -- the map then
// shows its own menu, which is safe; half an answer could leave the script waiting forever.
// The DLL re-checks all of this itself (menu_answer.hpp) before it hides anything.

const TOKEN = /^[A-Za-z0-9_]{1,63}$/
const MAX = 8

export const GAME_MODE_DVARS = ['enw_game_mode', 'enw_menu_hide', 'enw_menu_answer', 'enw_menu_done']

function tokens(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX) return null
  const out = list.map(String)
  return out.every((t) => TOKEN.test(t)) ? out : null
}

/**
 * `[[name, value], ...]` for the command line, or `{ error }`. `null` in, `[]` out: a lease
 * with no game mode sets none of these, and the DLL stays dormant.
 */
export function gameModeDvars(gm) {
  if (gm == null) return { dvars: [] }
  if (typeof gm !== 'object') return { dvars: [], error: 'game_mode is not an object' }
  const id = String(gm.id ?? '')
  if (!TOKEN.test(id)) return { dvars: [], error: 'game_mode.id is not a plain token' }
  const hide = tokens(gm.hide)
  if (!hide) return { dvars: [], error: 'game_mode.hide is not a short list of plain tokens' }
  const menu = String(gm.answer_menu ?? '')
  if (!TOKEN.test(menu)) return { dvars: [], error: 'game_mode.answer_menu is not a plain token' }
  if (!hide.some((h) => h.toLowerCase() === menu.toLowerCase())) return { dvars: [], error: 'game_mode.answer_menu is not hidden' }
  const responses = tokens(gm.responses)
  if (!responses) return { dvars: [], error: 'game_mode.responses is not a short list of plain tokens' }
  const done = gm.done == null || gm.done === '' ? '' : String(gm.done)
  if (done && !TOKEN.test(done)) return { dvars: [], error: 'game_mode.done is not a plain token' }
  const packed = [id, hide.join('.'), menu, responses.join('.'), ...(done ? [done] : [])].join(':')
  return { dvars: [['enw_game_mode', packed]] }
}

/** The requested mode's id, or null. */
export function gameModeId(asg) {
  const id = asg && asg.game_mode && asg.game_mode.id
  return typeof id === 'string' && TOKEN.test(id) ? id : null
}
