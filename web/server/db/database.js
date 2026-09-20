'use strict'

// The ENW Zombies database — SQLite via better-sqlite3, exactly as ENW Movement does it
// (`CSGO-Matchmaker/server/db/database.js`). One file, WAL, synchronous statements, and a
// `migrate()` that is additive only: every statement is CREATE TABLE IF NOT EXISTS or an
// addColumn() that checks PRAGMA table_info first. Nothing here ever drops or rewrites a
// column, because the only way to lose a player's badge is to run a destructive migration.
//
// The table list is vault `99 - Build Spec` §5.5, in its order:
//
//   users · friends · maps · map_versions · map_files · manifests · tags/map_tags ·
//   playlists · parties/party_members/invites · games · game_players · replays ·
//   badges/badge_awards · xp_ledger/levels · boards/records · comments · ratings ·
//   favourites · reports · infractions/bans · presets · archive_sources
//
// plus four the spec implies but does not name, all of which exist in Movement under
// another noun: `boxes` (Movement's match_servers — a game box and its pull-protocol
// secret), `assignments` (what a box should be running), `chat_network` (the cross-server
// chat ring, Movement's lib/chatNetwork.js) and `map_of_week`.
//
// SteamID64 is stored as TEXT everywhere, never INTEGER: it does not fit in a JS number and
// a 17-digit id silently rounded is the single most expensive bug this schema could carry.

const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const DATA_DIR = process.env.ZM_DATA_DIR || path.join(__dirname, '..', '..', 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = process.env.ZM_DB_PATH || path.join(DATA_DIR, 'zombies.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const now = () => Date.now()

// Add a column if it is not already there. Movement's addColumn, same contract: additive
// migrations only, and calling it twice is free.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

function migrate() {
  db.exec(`
    -- ── Identity ────────────────────────────────────────────────────────────────────
    -- A Zombies account IS a Steam account. The ENW name is fetched over the narrow
    -- read-only SSO API (vault 11 §9b) and CACHED here: Zombies keeps its own user table
    -- and never depends on ENW being up to render a profile. Same for VIP — `vip_is` is a
    -- cache with a `vip_checked` timestamp, so an ENW outage downgrades nobody mid-game.
    --
    -- `deleted` is how account deletion works (99 §4.1): the row is ANONYMISED, never
    -- removed. Records, replays and badges are attached to it and must survive, so the
    -- display name becomes "Deleted player" and the Steam id stays as the join key.
    CREATE TABLE IF NOT EXISTS users (
      steam_id        TEXT PRIMARY KEY,
      username        TEXT,
      avatar          TEXT,
      enw_name        TEXT,
      enw_checked     INTEGER,
      vip_is          INTEGER DEFAULT 0,
      vip_checked     INTEGER,
      is_admin        INTEGER DEFAULT 0,
      is_mod          INTEGER DEFAULT 0,
      is_archivist    INTEGER DEFAULT 0,
      approved        INTEGER DEFAULT 0,
      settings_json   TEXT,
      privacy_history TEXT DEFAULT 'public',
      profile_comments TEXT DEFAULT 'everyone',
      pinned_badges   TEXT,
      level           INTEGER DEFAULT 1,
      prestige        INTEGER DEFAULT 0,
      xp_total        INTEGER DEFAULT 0,
      active_ms       INTEGER DEFAULT 0,
      deleted         INTEGER DEFAULT 0,
      created_at      INTEGER,
      last_seen       INTEGER
    );

    -- Movement's friendships table verbatim: one row per direction-less pair, keyed on who
    -- asked, with a status so a pending request is a first-class thing.
    CREATE TABLE IF NOT EXISTS friendships (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_steam_id  TEXT NOT NULL,
      addressee_steam_id  TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      created_at          INTEGER,
      updated_at          INTEGER,
      UNIQUE(requester_steam_id, addressee_steam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships(addressee_steam_id, status);
    CREATE INDEX IF NOT EXISTS idx_friend_requester ON friendships(requester_steam_id, status);

    -- ── The archive ─────────────────────────────────────────────────────────────────
    -- A MAP is the work; a MAP_VERSION is a release of it. Everything a player does
    -- attaches to a version (99 §4.7: boards are per map version, old versions freeze),
    -- and everything a browser filters on lives on the map.
    --
    -- `key` is the engine name (`nazi_zombie_factory`) and is the map's identity: it is what
    -- the game box reports, what a manifest is filed under, and what a deep link carries
    -- (`zombies.enw.gg/m/<map>`). `slug` is the human URL and may be prettier.
    --
    -- `health` is the manifest's word (verified | playable | custom-only | broken), and it is
    -- load-bearing: 99 §4.8 says a map broken on our servers is HIDDEN from the Maps list and
    -- appears only on the Archive page. That is a read-time filter on this column.
    CREATE TABLE IF NOT EXISTS maps (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT UNIQUE NOT NULL,
      slug           TEXT UNIQUE,
      title          TEXT NOT NULL,
      author         TEXT,
      year           INTEGER,
      source         TEXT DEFAULT 'custom',
      health         TEXT DEFAULT 'playable',
      hidden         INTEGER DEFAULT 0,
      main_finish    TEXT DEFAULT 'round',
      round_n        INTEGER DEFAULT 20,
      has_ee         INTEGER DEFAULT 0,
      has_buyable    INTEGER DEFAULT 0,
      description    TEXT,
      readme         TEXT,
      release_post   TEXT,
      art            TEXT,
      released_at    INTEGER,
      added_at       INTEGER,
      plays          INTEGER DEFAULT 0,
      beaten_by      INTEGER DEFAULT 0,
      thumbs_up      INTEGER DEFAULT 0,
      thumbs_down    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_maps_health ON maps(health, hidden);

    CREATE TABLE IF NOT EXISTS map_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id       INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      version      TEXT NOT NULL,
      latest       INTEGER DEFAULT 0,
      health       TEXT DEFAULT 'playable',
      fs_game      TEXT,
      notes        TEXT,
      size_bytes   INTEGER,
      sha256       TEXT,
      released_at  INTEGER,
      added_at     INTEGER,
      UNIQUE(map_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_map_versions_latest ON map_versions(map_id, latest);

    -- The originals are sacred (99 §4.8): the exact file, its sha256, where it came from and
    -- when. This table is the proof, and nothing in the site may rewrite a row's hash.
    CREATE TABLE IF NOT EXISTS map_files (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      map_version_id  INTEGER NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
      path            TEXT NOT NULL,
      sha256          TEXT,
      size            INTEGER,
      kind            TEXT DEFAULT 'pack',
      source_url      TEXT,
      fetched_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_map_files_version ON map_files(map_version_id);

    -- One referee manifest per version, stored whole. The site does NOT re-implement the
    -- evaluator (`infra/host-agent/lib/manifests.js` owns that): it reads the manifest for
    -- the map page's "what counts as beating this" block, the badge rules and the finish
    -- labels, and hands the file itself to the box in the assignment.
    CREATE TABLE IF NOT EXISTS manifests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      map_version_id  INTEGER NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
      map_key         TEXT NOT NULL,
      schema          TEXT,
      confidence      TEXT,
      json            TEXT NOT NULL,
      imported_at     INTEGER,
      UNIQUE(map_version_id)
    );
    CREATE INDEX IF NOT EXISTS idx_manifests_key ON manifests(map_key);

    CREATE TABLE IF NOT EXISTS tags (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      slug   TEXT UNIQUE NOT NULL,
      label  TEXT NOT NULL,
      kind   TEXT DEFAULT 'trait',
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS map_tags (
      map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (map_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_map_tags_tag ON map_tags(tag_id);

    -- ── Playlists (Movement's machinery, unchanged) ──────────────────────────────────
    -- `reward_badge` holds a BADGE ID, never a slug — Movement learned that the hard way
    -- (its comment: a rename must never orphan a badge people already hold). The rule key
    -- is `playlist-<id>` for the same reason.
    --
    -- `kind` is the one addition: 13 §3 wants a staff-curated kind and an AUTOMATIC one per
    -- creator. A `creator` playlist has no hand-picked member rows; it is defined by its
    -- `creator` column and resolved at read time, so a newly imported map by that author
    -- joins the list without anybody editing it.
    CREATE TABLE IF NOT EXISTS playlists (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      blurb        TEXT,
      kind         TEXT NOT NULL DEFAULT 'curated',
      creator      TEXT,
      state        TEXT NOT NULL DEFAULT 'hidden',
      live_from    INTEGER,
      sort_order   INTEGER DEFAULT 0,
      reward_badge INTEGER DEFAULT 0,
      created_at   INTEGER,
      created_by   TEXT,
      updated_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlist_maps (
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      map_key     TEXT NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      added_at    INTEGER,
      PRIMARY KEY (playlist_id, map_key)
    );

    CREATE TABLE IF NOT EXISTS map_of_week (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start INTEGER NOT NULL UNIQUE,
      map_key    TEXT NOT NULL,
      note       TEXT,
      set_at     INTEGER,
      set_by     TEXT
    );

    -- ── Parties and lobbies ─────────────────────────────────────────────────────────
    -- Movement's party rail, with "mode" now meaning Verified / Custom / Local.
    -- `visibility` is private | friends | public (13 §4b). A public party is what "Find a
    -- game" quick-join searches and what shows under Live games.
    --
    -- The READY CHECK is three columns rather than a table: a check belongs to exactly one
    -- party and is replaced wholesale when the leader starts another.
    CREATE TABLE IF NOT EXISTS parties (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT UNIQUE,
      leader       TEXT NOT NULL,
      mode         TEXT NOT NULL DEFAULT 'verified',
      map_key      TEXT,
      preset_id    INTEGER,
      visibility   TEXT NOT NULL DEFAULT 'friends',
      state        TEXT NOT NULL DEFAULT 'forming',
      ready_since  INTEGER,
      match_id     TEXT,
      settings_json TEXT,
      created_at   INTEGER,
      updated_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_parties_state ON parties(state, visibility);
    CREATE TABLE IF NOT EXISTS party_members (
      party_id  INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
      steam_id  TEXT NOT NULL,
      ready     INTEGER DEFAULT 0,
      joined_at INTEGER,
      PRIMARY KEY (party_id, steam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_party_members_steam ON party_members(steam_id);
    CREATE TABLE IF NOT EXISTS party_invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id   INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
      from_steam TEXT NOT NULL,
      to_steam   TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER
    );

    -- ── Game boxes and the pull protocol ────────────────────────────────────────────
    -- Movement's match_servers. A box authenticates with a per-box shared secret in
    -- `x-match-secret` and the site NEVER connects out to it (host.md §1, and the CS fleet's
    -- reason: NAT, no inbound rules, no reachable RCON).
    --
    -- THE KEY PIN. `replay_pub` / `replay_key_id` is the box's Ed25519 REPLAY-SIGNING public
    -- key, pinned on first sight. This exists because `infra/host-agent` proved that a replay
    -- re-signed with a different key is internally consistent (host.md §5): the signature
    -- proves integrity, not authorship. Without a pin, anyone who can POST a result can also
    -- hand us a perfectly valid replay they wrote themselves. A key that ARRIVES DIFFERENT
    -- from the pin is not accepted silently — it lands in `replay_pub_pending` and an admin
    -- has to confirm it, which is the same shape as an SSH host-key change.
    CREATE TABLE IF NOT EXISTS boxes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT UNIQUE NOT NULL,
      match_key       TEXT UNIQUE NOT NULL,
      region          TEXT,
      note            TEXT,
      enabled         INTEGER DEFAULT 1,
      max_instances   INTEGER DEFAULT 4,
      first_seen      INTEGER,
      last_poll       INTEGER,
      last_state      TEXT,
      last_status_json TEXT,
      polls           INTEGER DEFAULT 0,
      replay_pub      TEXT,
      replay_key_id   TEXT,
      key_pinned_at   INTEGER,
      replay_pub_pending TEXT,
      pending_key_id  TEXT,
      pending_seen_at INTEGER,
      created_at      INTEGER
    );

    -- What a box should be running right now. One live row per box (the pull protocol has no
    -- queue on the box side); finished rows stay for the audit trail.
    --
    -- `nonce` is the whole reason a 3-second poll costs nothing: the box caches it and only
    -- reconfigures when it changes (lib/siteclient.js). It is a hash of the assignment with
    -- the tokens and the timestamp removed, so re-issuing the identical lease does not churn
    -- a running game.
    CREATE TABLE IF NOT EXISTS assignments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id        INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
      match_id      TEXT UNIQUE NOT NULL,
      party_id      INTEGER,
      map_key       TEXT NOT NULL,
      map_version_id INTEGER,
      fs_game       TEXT,
      mode          TEXT NOT NULL DEFAULT 'verified',
      settings_json TEXT,
      players_json  TEXT,
      tokens_json   TEXT,
      vip           INTEGER DEFAULT 0,
      kind          TEXT DEFAULT 'game',
      nonce         TEXT,
      state         TEXT NOT NULL DEFAULT 'leased',
      issued_at     INTEGER,
      acked_at      INTEGER,
      ready_at      INTEGER,
      ended_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_assignments_box ON assignments(box_id, state);

    -- ── Games ───────────────────────────────────────────────────────────────────────
    -- One row per game our servers refereed, written from the box's POST /api/gs/result.
    -- The referee's summary (host.md §4) is stored WHOLE in summary_json as well as being
    -- projected into columns: the columns are what the site queries, the blob is what proves
    -- what the box actually said, and the two must never be reconciled by hand.
    CREATE TABLE IF NOT EXISTS games (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id         TEXT UNIQUE NOT NULL,
      box              TEXT,
      instance         TEXT,
      mode             TEXT NOT NULL DEFAULT 'verified',
      map_key          TEXT NOT NULL,
      map_id           INTEGER,
      map_version_id   INTEGER,
      fs_game          TEXT,
      party_id         INTEGER,
      settings_json    TEXT,
      fingerprint      TEXT,
      rounds           INTEGER DEFAULT 0,
      finish_kind      TEXT,
      finish_label     TEXT,
      badge_earned     TEXT,
      player_count     INTEGER DEFAULT 0,
      solo             INTEGER DEFAULT 0,
      duration_ms      INTEGER DEFAULT 0,
      duration_rta_ms  INTEGER DEFAULT 0,
      paused_ms        INTEGER DEFAULT 0,
      flags            TEXT,
      records_eligible INTEGER DEFAULT 0,
      xp_multiplier    REAL DEFAULT 1,
      end_reason       TEXT,
      started_at       INTEGER,
      ended_at         INTEGER,
      received_at      INTEGER,
      summary_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_games_map ON games(map_key, ended_at);
    CREATE INDEX IF NOT EXISTS idx_games_ended ON games(ended_at);

    CREATE TABLE IF NOT EXISTS game_players (
      game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      steam_id      TEXT NOT NULL,
      slot          INTEGER,
      name          TEXT,
      score         INTEGER DEFAULT 0,
      kills         INTEGER DEFAULT 0,
      headshots     INTEGER DEFAULT 0,
      downs         INTEGER DEFAULT 0,
      revives       INTEGER DEFAULT 0,
      bleedouts     INTEGER DEFAULT 0,
      points_earned INTEGER DEFAULT 0,
      points_spent  INTEGER DEFAULT 0,
      time_alive_ms INTEGER DEFAULT 0,
      rounds_played INTEGER DEFAULT 0,
      joined_round  INTEGER DEFAULT 1,
      late          INTEGER DEFAULT 0,
      afk_kicked    INTEGER DEFAULT 0,
      xp_awarded    INTEGER DEFAULT 0,
      PRIMARY KEY (game_id, steam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_game_players_steam ON game_players(steam_id);

    -- The replay pointer. 99 §5.5 says `game_events` OR a replay pointer only; the host agent
    -- already writes a hash-chained signed container, so the pointer is what the site keeps
    -- and the events live in the file.
    --
    -- `key_pinned` records whether the signing key matched the box's pin AT INGEST. A 0 here
    -- means the file may be a perfectly valid replay signed by somebody else, which is
    -- exactly the case host.md §5 says must not be graded as record evidence.
    CREATE TABLE IF NOT EXISTS replays (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id    TEXT UNIQUE NOT NULL,
      game_id     INTEGER REFERENCES games(id) ON DELETE CASCADE,
      box         TEXT,
      object_key  TEXT,
      file        TEXT,
      size        INTEGER,
      chunks      INTEGER,
      events      INTEGER,
      ratio       REAL,
      mb_per_hour REAL,
      key_id      TEXT,
      key_pinned  INTEGER DEFAULT 0,
      recovered   INTEGER DEFAULT 0,
      partial     INTEGER DEFAULT 0,
      tier        TEXT DEFAULT 'full',
      vip_keep    INTEGER DEFAULT 0,
      expires_at  INTEGER,
      created_at  INTEGER
    );

    -- ── Badges ──────────────────────────────────────────────────────────────────────
    -- Movement's two tables and its `kind` column, with two zombies kinds added:
    --
    --   staff        hand-awarded (Archivist, Map Maker, Content Creator)
    --   achievement  a rule the site checks (round milestones, maps completed, collections)
    --   map          THE map badge: one per map, earned by the map's main finish (05)
    --   record       HELD, not earned — gold while you hold a record on that map, and it
    --                moves with the record. Movement's `kind: 'record'` verbatim.
    --
    -- A record badge is the only kind a sweep may take away, and it is taken away by moving
    -- it, never by deleting the history. Everything else: earned is earned.
    CREATE TABLE IF NOT EXISTS badges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      obtain      TEXT,
      kind        TEXT NOT NULL DEFAULT 'staff',
      rule        TEXT,
      family      TEXT,
      map_key     TEXT,
      art         TEXT,
      sort_order  INTEGER DEFAULT 0,
      retired     INTEGER DEFAULT 0,
      created_at  INTEGER,
      created_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_badges_map ON badges(map_key);
    CREATE TABLE IF NOT EXISTS badge_awards (
      badge_id   INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      steam_id   TEXT NOT NULL,
      awarded_at INTEGER,
      awarded_by TEXT,
      note       TEXT,
      solo       INTEGER DEFAULT 0,
      ticks      TEXT,
      game_id    INTEGER,
      PRIMARY KEY (badge_id, steam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_badge_awards_steam ON badge_awards(steam_id);
    CREATE INDEX IF NOT EXISTS idx_badge_awards_badge ON badge_awards(badge_id, awarded_at);

    -- Who has held a record badge, and for how long. Movement's map_record_holds: the badge
    -- moves, the history does not.
    CREATE TABLE IF NOT EXISTS badge_holds (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      badge_id  INTEGER NOT NULL,
      steam_id  TEXT NOT NULL,
      from_at   INTEGER,
      to_at     INTEGER,
      reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_badge_holds_badge ON badge_holds(badge_id, from_at);

    -- ── XP, levels, prestige ────────────────────────────────────────────────────────
    -- XP is ACTIVE TIME (05): Verified full, Custom 25%, Local none. One ledger row per
    -- credited game, never a mutated total — `users.xp_total` is a cache that can be rebuilt
    -- from this table, and an XP dispute is answered by reading rows rather than by trusting
    -- a counter.
    CREATE TABLE IF NOT EXISTS xp_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_id    TEXT NOT NULL,
      game_id     INTEGER,
      reason      TEXT NOT NULL DEFAULT 'game',
      active_ms   INTEGER DEFAULT 0,
      multiplier  REAL DEFAULT 1,
      xp          INTEGER DEFAULT 0,
      note        TEXT,
      created_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_xp_steam ON xp_ledger(steam_id, created_at);

    -- ── Boards and records ──────────────────────────────────────────────────────────
    -- A BOARD is (map version, category, player count, rule profile). 99 §4.7: every ZWR /
    -- speedrun.com / Category-Extension category, split solo/2p/3p/4p, per map version, plus
    -- highest round per player count and the EE / Buyable Ending speedruns.
    --
    -- `sort` is 'time_asc' (a speedrun) or 'round_desc' (a high round). It lives on the board
    -- rather than being inferred from the category name, because the ranking rule is the one
    -- thing a board cannot get wrong.
    CREATE TABLE IF NOT EXISTS boards (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      map_key        TEXT NOT NULL,
      map_version_id INTEGER,
      category       TEXT NOT NULL,
      label          TEXT,
      player_count   INTEGER NOT NULL DEFAULT 1,
      profile        TEXT NOT NULL DEFAULT 'ENW-Verified',
      sort           TEXT NOT NULL DEFAULT 'round_desc',
      frozen         INTEGER DEFAULT 0,
      created_at     INTEGER,
      UNIQUE(map_key, map_version_id, category, player_count, profile)
    );
    CREATE INDEX IF NOT EXISTS idx_boards_map ON boards(map_key);

    -- One row per RUN, not per player. A zombies high round is a team's, so `steam_id` is
    -- the run's primary holder (the lowest slot still connected at the end) and `roster` is
    -- the JSON list of everyone who was in it — all of whom hold the record badge and all of
    -- whom the board shows. `current` marks a roster's standing entry on that board, so a
    -- slower later run is kept (it is evidence) but does not appear on the board.
    CREATE TABLE IF NOT EXISTS records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id     INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      steam_id     TEXT NOT NULL,
      roster       TEXT,
      game_id      INTEGER,
      match_id     TEXT,
      value_ms     INTEGER,
      round        INTEGER,
      fingerprint  TEXT,
      profile_ok   INTEGER DEFAULT 1,
      profile_note TEXT,
      current      INTEGER DEFAULT 1,
      verified     INTEGER DEFAULT 1,
      created_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_records_board ON records(board_id, current);
    CREATE INDEX IF NOT EXISTS idx_records_steam ON records(steam_id);

    -- The site-wide feed on the home page (13 §3: latest records + badges).
    CREATE TABLE IF NOT EXISTS feed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,
      steam_id   TEXT,
      map_key    TEXT,
      badge_id   INTEGER,
      game_id    INTEGER,
      text       TEXT,
      data_json  TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_feed_created ON feed(created_at);

    -- ── Social ──────────────────────────────────────────────────────────────────────
    -- Map comments and profile comments in one table, as Movement has them in two: the
    -- moderation surface, the removal rule and the rendering are identical, and one table is
    -- one reports queue.
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,
      subject    TEXT NOT NULL,
      steam_id   TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER,
      edited_at  INTEGER,
      removed    INTEGER DEFAULT 0,
      removed_by TEXT,
      removed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_comments_subject ON comments(kind, subject, created_at);

    -- Thumbs, post-match only: `game_id` is not decoration, it is the proof that the rater
    -- played the map (13 §2c — only players who've played it can rate).
    CREATE TABLE IF NOT EXISTS ratings (
      map_key    TEXT NOT NULL,
      steam_id   TEXT NOT NULL,
      thumbs     INTEGER NOT NULL,
      game_id    INTEGER,
      created_at INTEGER,
      PRIMARY KEY (map_key, steam_id)
    );

    CREATE TABLE IF NOT EXISTS favourites (
      map_key    TEXT NOT NULL,
      steam_id   TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (map_key, steam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_favourites_steam ON favourites(steam_id);

    -- ── Moderation ──────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,
      subject    TEXT,
      reporter   TEXT NOT NULL,
      reported   TEXT,
      reason     TEXT,
      detail     TEXT,
      status     TEXT NOT NULL DEFAULT 'new',
      handled_by TEXT,
      handled_at INTEGER,
      note       TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

    CREATE TABLE IF NOT EXISTS infractions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      note       TEXT,
      by_steam   TEXT,
      report_id  INTEGER,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_infractions_steam ON infractions(steam_id, created_at);

    -- `scope` is the whole design (05): a griefing ban is 'public' — the player keeps playing
    -- with friends and loses public lobbies and quick-join. A cheating ban is 'site' AND it
    -- wipes records and map badges; nothing else does.
    CREATE TABLE IF NOT EXISTS bans (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_id   TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT 'site',
      reason     TEXT,
      cheating   INTEGER DEFAULT 0,
      by_steam   TEXT,
      created_at INTEGER,
      expires_at INTEGER,
      active     INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_bans_steam ON bans(steam_id, active);

    -- ── Custom-game presets ─────────────────────────────────────────────────────────
    -- The eight knob groups of 13 §4c, saved to an account and shared by CODE.
    -- `locked` marks the four Verified challenge presets (No Power, No Perks, No Jug, First
    -- Room): those are not free-form knobs, they are fixed rulesets with their own boards.
    CREATE TABLE IF NOT EXISTS presets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      owner      TEXT,
      name       TEXT NOT NULL,
      blurb      TEXT,
      knobs_json TEXT NOT NULL,
      locked     INTEGER DEFAULT 0,
      featured   INTEGER DEFAULT 0,
      uses       INTEGER DEFAULT 0,
      created_at INTEGER
    );

    -- ── Archive pipeline bookkeeping ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS archive_sources (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      url          TEXT NOT NULL,
      site         TEXT,
      kind         TEXT DEFAULT 'download',
      map_key      TEXT,
      status       TEXT DEFAULT 'unchecked',
      http_status  INTEGER,
      note         TEXT,
      last_checked INTEGER,
      created_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_archive_sources_map ON archive_sources(map_key);

    -- ── Cross-server chat ───────────────────────────────────────────────────────────
    -- The ring the boxes drain over /api/gs/chat-feed and the site shows live. Capped by the
    -- reaper in lib/chatNetwork.js; the id is the long-poll cursor.
    CREATE TABLE IF NOT EXISTS chat_network (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      at       INTEGER,
      origin   TEXT,
      channel  TEXT DEFAULT 'global',
      from_name TEXT,
      steam_id TEXT,
      text     TEXT NOT NULL,
      map_key  TEXT,
      instance TEXT,
      removed  INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chat_at ON chat_network(at);

    -- Who is where. Movement's presence + whereabouts in one row per player: a box roster
    -- entry BEATS a lobby seat (11 §9, lib/whereabouts.js) because the box is the only thing
    -- that knows what is actually happening.
    CREATE TABLE IF NOT EXISTS presence (
      steam_id   TEXT PRIMARY KEY,
      seen_at    INTEGER,
      source     TEXT,
      match_id   TEXT,
      map_key    TEXT,
      box        TEXT,
      party_id   INTEGER
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event      TEXT NOT NULL,
      actor      TEXT,
      metadata   TEXT,
      logged_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_activity_event ON activity_log(event, logged_at);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER
    );
  `)

  // ---- additive columns ------------------------------------------------------------
  // Everything below is a later change. They are here rather than in the block above so the
  // block above can stay the readable statement of the schema.

  // The map shelf (05) needs per-player, per-map state that is NOT a badge: which finishes
  // this player has ticked on this map. A badge is one per map; the ticks are the rest.
  db.exec(`CREATE TABLE IF NOT EXISTS map_progress (
    steam_id      TEXT NOT NULL,
    map_key       TEXT NOT NULL,
    played        INTEGER DEFAULT 0,
    beaten        INTEGER DEFAULT 0,
    solo          INTEGER DEFAULT 0,
    best_round    INTEGER DEFAULT 0,
    ee            INTEGER DEFAULT 0,
    buyable       INTEGER DEFAULT 0,
    games         INTEGER DEFAULT 0,
    time_ms       INTEGER DEFAULT 0,
    first_played  INTEGER,
    last_played   INTEGER,
    PRIMARY KEY (steam_id, map_key)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_map_progress_map ON map_progress(map_key)')

  // A creator page is a row so a claim can be recorded against it (05: claims by staff
  // judgement → the Map Maker badge). Maps still carry their author string; this table is
  // only for the ones somebody has claimed or that staff have written a page for.
  db.exec(`CREATE TABLE IF NOT EXISTS creators (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    bio         TEXT,
    links       TEXT,
    claimed_by  TEXT,
    claimed_at  INTEGER,
    verified_by TEXT,
    created_at  INTEGER
  )`)

  return db
}

migrate()

module.exports = { db, now, migrate, addColumn, DB_PATH, DATA_DIR }
