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
    -- and never depends on ENW being up to render a profile. Same for VIP — \`vip_is\` is a
    -- cache with a \`vip_checked\` timestamp, so an ENW outage downgrades nobody mid-game.
    --
    -- \`deleted\` is how account deletion works (99 §4.1): the row is ANONYMISED, never
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

    -- ONE NAME, ONE ACCOUNT (2026-09-23). The ENW name is the display name everywhere —
    -- site, launcher header, party panel, and the name the referee pins in game — so two
    -- accounts answering to the same name is an impersonation, not a cosmetic clash.
    -- NOCASE because "Jamie" and "jamie" are the same claim to a reader.
    --
    -- Partial, on \`deleted = 0\`: anonymisation NULLs the column anyway (lib/users.js), and
    -- a freed name should be claimable again rather than reserved forever by a dead row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_enw_name
      ON users(enw_name COLLATE NOCASE) WHERE enw_name IS NOT NULL AND deleted = 0;

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
    -- \`key\` is the engine name (\`nazi_zombie_factory\`) and is the map's identity: it is what
    -- the game box reports, what a manifest is filed under, and what a deep link carries
    -- (\`zombies.enw.gg/m/<map>\`). \`slug\` is the human URL and may be prettier.
    --
    -- \`health\` is the manifest's word (verified | playable | custom-only | broken), and it is
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
    -- evaluator (\`infra/host-agent/lib/manifests.js\` owns that): it reads the manifest for
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
    -- \`reward_badge\` holds a BADGE ID, never a slug — Movement learned that the hard way
    -- (its comment: a rename must never orphan a badge people already hold). The rule key
    -- is \`playlist-<id>\` for the same reason.
    --
    -- \`kind\` is the one addition: 13 §3 wants a staff-curated kind and an AUTOMATIC one per
    -- creator. A \`creator\` playlist has no hand-picked member rows; it is defined by its
    -- \`creator\` column and resolved at read time, so a newly imported map by that author
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
    -- \`visibility\` is private | friends | public (13 §4b). A public party is what "Find a
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
    -- \`x-match-secret\` and the site NEVER connects out to it (host.md §1, and the CS fleet's
    -- reason: NAT, no inbound rules, no reachable RCON).
    --
    -- THE KEY PIN. \`replay_pub\` / \`replay_key_id\` is the box's Ed25519 REPLAY-SIGNING public
    -- key, pinned on first sight. This exists because \`infra/host-agent\` proved that a replay
    -- re-signed with a different key is internally consistent (host.md §5): the signature
    -- proves integrity, not authorship. Without a pin, anyone who can POST a result can also
    -- hand us a perfectly valid replay they wrote themselves. A key that ARRIVES DIFFERENT
    -- from the pin is not accepted silently — it lands in \`replay_pub_pending\` and an admin
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
    -- \`nonce\` is the whole reason a 3-second poll costs nothing: the box caches it and only
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

    -- The replay pointer. 99 §5.5 says \`game_events\` OR a replay pointer only; the host agent
    -- already writes a hash-chained signed container, so the pointer is what the site keeps
    -- and the events live in the file.
    --
    -- \`key_pinned\` records whether the signing key matched the box's pin AT INGEST. A 0 here
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
    -- Movement's two tables and its \`kind\` column, with two zombies kinds added:
    --
    --   staff        hand-awarded (Archivist, Map Maker, Content Creator)
    --   achievement  a rule the site checks (round milestones, maps completed, collections)
    --   map          THE map badge: one per map, earned by the map's main finish (05)
    --   record       HELD, not earned — gold while you hold a record on that map, and it
    --                moves with the record. Movement's \`kind: 'record'\` verbatim.
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
    -- credited game, never a mutated total — \`users.xp_total\` is a cache that can be rebuilt
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
    -- \`sort\` is 'time_asc' (a speedrun) or 'round_desc' (a high round). It lives on the board
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

    -- One row per RUN, not per player. A zombies high round is a team's, so \`steam_id\` is
    -- the run's primary holder (the lowest slot still connected at the end) and \`roster\` is
    -- the JSON list of everyone who was in it — all of whom hold the record badge and all of
    -- whom the board shows. \`current\` marks a roster's standing entry on that board, so a
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

    -- Thumbs, post-match only: \`game_id\` is not decoration, it is the proof that the rater
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

    -- \`scope\` is the whole design (05): a griefing ban is 'public' — the player keeps playing
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
    -- \`locked\` marks the four Verified challenge presets (No Power, No Perks, No Jug, First
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
      kind     TEXT DEFAULT 'chat',
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
  // The address players are told to connect to for games on this box.
  //
  // It is PROVISION-TIME data, deliberately not something the box asserts about itself: a
  // box reports `host.public_ip` in its status and the site will use that when this is
  // null, but a box that can name its own connect address can also name somebody else's,
  // and the connect string is what a player's game dials. For a dev box on this machine
  // it is `127.0.0.1`.
  addColumn('boxes', 'address', 'TEXT')

  // SEVERAL GAMES PER BOX (2026-09-23, lib/assignments.js "SEVERAL GAMES PER BOX").
  // `reserve`: slots on this box only an agent lease may take (NULL = 1 on a box of 3 or
  // more, else 0). `agent`: this lease is an agent's, so it may use the reserve and it is
  // the one a real player's lease supersedes when the box is full.
  //
  // zombies-dev runs three instances since dedi.md §19 (three game copies, one lobby port
  // each). Written ONCE, on the migration that adds the column, so an admin who changes
  // it afterwards (POST /api/admin/boxes/:name/capacity) is never overruled by a restart.
  if (addColumn('boxes', 'reserve', 'INTEGER')) {
    const n = db.prepare("UPDATE boxes SET max_instances=3 WHERE name='zombies-dev'").run().changes
    if (n) console.log('[db] zombies-dev: max_instances 3 (three instance slots, dedi.md §19)')
  }
  addColumn('assignments', 'agent', 'INTEGER DEFAULT 0')

  // Where a map's picture came from (2026-09-22, tools/maps/map_art.py): `site` (scraped
  // art), `iwd` (the map's own loading screen), `stock` (WaW's), or `placeholder` (a
  // generated card). The map page credits it, and a generated card must never pass for a
  // screenshot. The script adds the same column itself if it runs before a server has.
  addColumn('maps', 'art_source', 'TEXT')
  // A download link's size as the link checker measured it, so the map page can say how
  // big the map is before anybody clicks. Written by db/import-archive.js --catalogue.
  addColumn('archive_sources', 'size_bytes', 'INTEGER')

  // A chat line is either something a person typed (`chat`) or a sentence the site
  // composed out of a game event (`system`, lib/chatSystem.js). The panel draws them
  // differently. It is a column and not a prefix on the text, because a marker inside
  // the text is a marker a player can type.
  addColumn('chat_network', 'kind', "TEXT DEFAULT 'chat'")

  // Discord. `discord_id` is the snowflake, and its presence is the WHOLE "is this person
  // in the Discord" test the top-right link asks (see routes/site.js `/api/me`): a user
  // who has linked is a user we stop advertising the invite to. Linking itself is not
  // built yet — `docs/kickstart/web.md` §12d — so today nothing ever sets it and the link
  // shows for everyone, which is the honest failure direction: an invite shown to somebody
  // already inside is a mild annoyance, an invite hidden from somebody outside is the
  // feature not working.
  addColumn('users', 'discord_id', 'TEXT')
  addColumn('users', 'discord_name', 'TEXT')
  addColumn('users', 'discord_linked_at', 'INTEGER')

  // When the Steam picture in `avatar` was last read off the player's public profile
  // (lib/steamAvatar.js). Once at sign-in, then at most once a day; never per page.
  addColumn('users', 'avatar_checked', 'INTEGER')

  // A game the SITE did not referee on a box it controls.
  //
  // A Local game (13 §4) runs on the player's own PC with the console and cheats available,
  // and its result reaches us from that same PC. We store it — a player should be able to
  // see they played Leviathan for forty minutes — but it is **self-reported**, and this
  // column is what stops that ever being forgotten downstream. Nothing self-reported earns
  // a badge, a record or a point of XP, and the grader refuses to call its replay evidence
  // however well signed it is.
  //
  // It is a column rather than an inference from `mode` because the two can come apart: a
  // Verified game posted through a door that does not prove a box sent it would also be
  // self-reported, and that is the case worth being able to name.
  addColumn('games', 'self_reported', 'INTEGER DEFAULT 0')

  // One row per (version, path). Without this, the `INSERT OR IGNORE` that both the seeder
  // and the archive importer use has nothing to conflict WITH, so it is a plain INSERT and
  // every re-import duplicates every file row. Found by running the importer twice and
  // counting (63 rows where 35 were expected).
  //
  // The de-dupe keeps the LOWEST id per (version, path) — the first time we recorded the
  // file, which is the one whose `fetched_at` is true.
  db.exec(`DELETE FROM map_files WHERE id NOT IN (
             SELECT MIN(id) FROM map_files GROUP BY map_version_id, path)`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_map_files_unique ON map_files(map_version_id, path)')

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

  // ── A local game in flight ────────────────────────────────────────────────────────
  //
  // This used to be a `Map` in routes/launcher.js, and that was the single biggest hole in
  // the MVP: a player finishes a forty-minute run, the site has restarted in the meantime
  // (a deploy, a crash, `node --watch` on a save), and `POST /local/result` answers
  // **"not your game"**. The run is gone and there is nothing to recover it from.
  //
  // So the match is a row. It is the site's record that a run is happening, it survives a
  // restart, it carries the highest round a live frame reported — so even a run whose
  // result never arrives leaves a number behind — and a sweep closes the ones nobody ever
  // finished instead of letting them sit "live" forever.
  //
  // It is NOT the game. A game is the `games` row that `lib/results.ingest` writes when the
  // result arrives (or when the sweep gives up on it). This table is the thing in between.
  //
  //   state: live      started, still heartbeating
  //          done      a result arrived and became a game
  //          abandoned no heartbeat for LOCAL_STALE_MS and no result
  db.exec(`CREATE TABLE IF NOT EXISTS local_matches (
    match_id    TEXT PRIMARY KEY,
    steam_id    TEXT NOT NULL,
    map_key     TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'live',
    round       INTEGER NOT NULL DEFAULT 0,
    frames      INTEGER NOT NULL DEFAULT 0,
    game_id     INTEGER,
    started_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    ended_at    INTEGER
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_local_matches_player ON local_matches(steam_id, started_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_local_matches_state ON local_matches(state, last_seen)')

  // ── Collections: the home rows ────────────────────────────────────────────────────
  //
  // Movement's mode home is ROWS, and which maps are in a row is an editorial decision that
  // changes weekly. B's three — New maps, Vanilla, High production — are therefore a TABLE
  // and not a constant in the client: "seed it with Leviathan and make the membership
  // editable from admin, not hard-coded" (B, 2026-09-22).
  //
  // Two kinds, and the difference is who decides:
  //   auto    the row is a QUERY. `auto` holds the query name ('newest', 'popular',
  //           'stock'), it is resolved at read time, and a map imported tonight joins
  //           "New maps" without anybody editing anything.
  //   manual  the row is `collection_maps`, in `position` order. Vanilla and High
  //           production are manual because both are judgements.
  //
  // It is NOT `playlists`. A playlist is a thing you complete for a badge — it has a
  // reward, a live_from date and per-player progress (lib/playlists.js), and hanging a
  // shelf row off that machinery would mean every row on the home page was also a
  // challenge somebody could be half way through.
  db.exec(`CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    blurb       TEXT,
    kind        TEXT NOT NULL DEFAULT 'manual',
    auto        TEXT,
    state       TEXT NOT NULL DEFAULT 'live',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    limit_n     INTEGER NOT NULL DEFAULT 12,
    created_at  INTEGER,
    updated_at  INTEGER,
    updated_by  TEXT
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS collection_maps (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    map_key       TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    added_at      INTEGER,
    PRIMARY KEY (collection_id, map_key)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_collections_live ON collections(state, sort_order)')
  seedCollections()

  // ── A player's ENW Movement profile, mirrored (2026-09-22, lib/movementProfile.js) ──────
  //
  // The banner a player set on Movement shows on their profile here, the same picture, so
  // it is read from Movement's public profile and the FILE is copied into <data>/media/banners
  // (never hotlinked). Its own table rather than columns on `users`: it is a cache of another
  // site's data with its own freshness, and a row here for somebody who has never opened
  // this site is fine.
  //
  // Only what the profile shows is kept: the banner and its crop, the country code, and the
  // Movement username (for spotting a mismatch; never displayed). No avatar, no badges, no
  // skins, no email — Movement's public projection carries no email or real name to begin
  // with, and nothing else is asked for.
  //
  //   found        1 = Movement has this SteamID; 0 = it answered "no such player"
  //   banner_src   Movement's path (/banners/<steamid>-<hex>.<ext>), content-addressed there
  //   banner_file  our copy's filename under media/banners, null when there is none
  db.exec(`CREATE TABLE IF NOT EXISTS movement_profiles (
    steam_id     TEXT PRIMARY KEY,
    found        INTEGER NOT NULL DEFAULT 0,
    mv_name      TEXT,
    banner_src   TEXT,
    banner_file  TEXT,
    banner_pos   INTEGER DEFAULT 50,
    country      TEXT,
    fetched_at   INTEGER,
    checked_at   INTEGER,
    error        TEXT
  )`)

  // Easter egg / power / song / ending guides (2026-09-23, lib/guides.js). One row per
  // (map, kind, title) — `sig` — written only by `import-archive.js --guides` out of
  // archive/easter_eggs.py's report, never over HTTP. `state` is staff's: live, hidden
  // (reversible) or deleted (a tombstone the next import respects). `origin` is 'archive'
  // today; guides read out of a map's own scripts will be 'script'.
  db.exec(`CREATE TABLE IF NOT EXISTS map_guides (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sig           TEXT UNIQUE NOT NULL,
    map_key       TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('easter_egg','power','song','ending','other')),
    title         TEXT NOT NULL,
    reward        TEXT,
    steps_json    TEXT NOT NULL,
    source_url    TEXT,
    source_site   TEXT,
    source_author TEXT,
    source_file   TEXT,
    confidence    REAL NOT NULL,
    evidence_json TEXT,
    origin        TEXT NOT NULL DEFAULT 'archive',
    state         TEXT NOT NULL DEFAULT 'live',
    staff_by      TEXT,
    staff_at      INTEGER,
    imported_at   INTEGER,
    updated_at    INTEGER
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_map_guides_map ON map_guides(map_key, state)')

  // Scaffolding, marked as scaffolding.
  //
  // `npm run seed -- --demo` writes six games so the pages are not empty, and it writes
  // them through the real ingest path so the demo exercises the same code a box drives.
  // The cost is that a demo game and a real one are the same shape, and B looking at his
  // own first run has no way to tell which rows are his. This column is the difference,
  // and it is set by the seeder and by nothing else — no request can set it.
  if (addColumn('games', 'demo', 'INTEGER DEFAULT 0')) {
    const n = markSeededDemoGames()
    if (n) console.log(`[db] marked ${n} seeded demo game${n === 1 ? '' : 's'}`)
  }

  return db
}

/**
 * Mark games that the seeder wrote, in a database seeded before `games.demo` existed —
 * B's live site among them, where six scaffolding games have been sitting in exactly the
 * shape of a real one.
 *
 * The marker is the replay pointer. `seedDemo()` is the only thing that has ever written
 * `demo.enwr`, and it writes it for every game it makes.
 *
 * It is deliberately NOT "every player on it is a demo account". The (since removed) mock sign-in page
 * hands those reserved ids out, so on this dev box B plays as one of them, and that rule
 * would mark his own runs as fake — which is the exact failure this column exists to
 * prevent, inverted.
 */
function markSeededDemoGames() {
  return db.prepare(`UPDATE games SET demo=1
                      WHERE COALESCE(demo,0)=0
                        AND id IN (SELECT game_id FROM replays WHERE file='demo.enwr')`).run().changes
}

/**
 * The three rows B named, created ONCE and then left alone.
 *
 * The membership is only written on the visit that creates the row. That matters: an admin
 * who takes Der Riese out of Vanilla must not find it back tomorrow because the server
 * restarted, and a seeder that re-asserted its list on every boot would be a second editor
 * quietly overruling the first. `INSERT OR IGNORE` on the collection is the whole guard —
 * `changes` tells us whether this process is the one that made it.
 *
 * "High production" is seeded with Leviathan alone, which is what B asked for and is also
 * the honest state: one map has been judged a big undertaking and the rest have not been
 * looked at yet. A row of four guesses would read as a verdict on the other 2,280.
 */
function seedCollections() {
  const t = now()
  const add = db.prepare(`INSERT OR IGNORE INTO collections
    (slug, name, blurb, kind, auto, state, sort_order, limit_n, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const member = db.prepare('INSERT OR IGNORE INTO collection_maps (collection_id, map_key, position, added_at) VALUES (?,?,?,?)')
  const idOf = (slug) => { const r = db.prepare('SELECT id FROM collections WHERE slug=?').get(slug); return r && r.id }
  const make = (slug, name, blurb, kind, auto, order, limit, maps = []) => {
    const r = add.run(slug, name, blurb, kind, auto, 'live', order, limit, t, t)
    if (!r.changes) return
    const id = idOf(slug)
    maps.forEach((k, i) => member.run(id, k, i, t))
  }
  make('new', 'New maps', 'The most recently added to the archive.', 'auto', 'newest', 10, 12)
  make('vanilla', 'Vanilla', 'The four that shipped with World at War.', 'manual', null, 20, 12,
    ['nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory'])
  make('high-production', 'High production', 'Big undertakings.', 'manual', null, 30, 12,
    ['nazi_zombie_leviathan'])
}

migrate()

module.exports = { db, now, migrate, addColumn, markSeededDemoGames, seedCollections, DB_PATH, DATA_DIR }
