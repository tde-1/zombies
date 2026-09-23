// How /settings PRESENTS the catalogue in wawSettings.js - and nothing else.
//
// B, 2026-09-22: "Clean up the settings menu. It should be like my project Gaff's settings
// menu, split off into little sections and really simplified." Gaff's screen
// (WatchGame/app/src/components/SettingsScreen.jsx) is a rail of a few tabs with icons, a
// search box above them, and inside each tab small lowercase section headings with one
// short row per setting. This file is that split for our settings.
//
// wawSettings.js stays the single source of truth for WHAT each row writes (dvar, values,
// game default, source, and its WaW menu in `section`). This file only says which tab and
// which little group a row is drawn in, a shorter label, a one-line hint where the value is
// not self-evident, and shorter option words for the segmented buttons. A test in
// web/test/run-all.js checks every catalogue item is placed exactly once.

import { ALL } from './wawSettings.js'

export const TABS = [
  { id: 'display', label: 'Display', icon: 'display' },
  { id: 'graphics', label: 'Graphics', icon: 'graphics' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'controls', label: 'Controls', icon: 'controls' },
  { id: 'game', label: 'Game', icon: 'game' },
  { id: 'enw', label: 'ENW', icon: 'enw' },
]

const binds = (section) => ALL.filter((i) => i.kind === 'bind' && i.section === section).map((i) => i.id)

// tab -> little groups, each with its own reset. Order inside a group is the order drawn.
export const GROUPS = [
  { tab: 'display', id: 'screen', label: 'screen', items: ['mode', 'display', 'resolution', 'r_displayRefresh', 'r_aspectRatio'] },
  { tab: 'display', id: 'picture', label: 'picture', items: ['fov', 'r_gamma', 'maxFps', 'vsync', 'showFps'] },
  { tab: 'graphics', id: 'quality', label: 'quality', items: ['r_aaSamples', 'sm_enable', 'r_specular', 'r_glow_allowed', 'r_dof_enable', 'r_multiGpu'] },
  { tab: 'graphics', id: 'world', label: 'world', items: ['ai_corpseCount', 'fx_marks', 'r_gfxopt_dynamic_foliage', 'r_gfxopt_water_simulation'] },
  { tab: 'graphics', id: 'textures', label: 'textures', items: ['r_texFilterAnisoMin', 'r_texFilterMipMode', 'r_picmip_manual', 'r_picmip', 'r_picmip_bump', 'r_picmip_spec'] },
  { tab: 'audio', id: 'volume', label: 'volume', items: ['snd_menu_master', 'snd_menu_music', 'snd_menu_sfx', 'snd_menu_voice', 'snd_cinematicVolumeScale'] },
  { tab: 'audio', id: 'sound', label: 'sound', items: ['snd_losOcclusion'] },
  { tab: 'controls', id: 'mouse', label: 'mouse', items: ['sensitivity', 'ui_mousePitch', 'm_filter', 'cl_freelook', 'rawMouse'] },
  { tab: 'controls', id: 'move', label: 'move', items: binds('move'), keys: true },
  { tab: 'controls', id: 'combat', label: 'combat', items: binds('combat'), keys: true },
  { tab: 'controls', id: 'interact', label: 'interact', items: binds('interact'), keys: true },
  { tab: 'controls', id: 'look', label: 'look', items: binds('look'), keys: true },
  { tab: 'game', id: 'game', label: 'game', items: ['cg_mature', 'cg_subtitles', 'hud_enable', 'cg_drawCrosshair', 'monkeytoy'] },
  // Drawn on the ENW tab under EnwSection (pages/Settings.jsx).
  { tab: 'enw', id: 'discord', label: 'discord', items: ['discordPresence', 'discordOverlay'] },
  { tab: 'enw', id: 'notifications', label: 'notifications', items: ['notifySound'] },
]

// Shorter, Gaff-style row labels. Anything not here uses the game's own label, lowercased.
export const LABELS = {
  mode: 'display mode',
  display: 'monitor',
  resolution: 'resolution',
  r_displayRefresh: 'refresh rate',
  r_aspectRatio: 'aspect ratio',
  r_gamma: 'brightness',
  vsync: 'vsync',
  maxFps: 'max fps',
  showFps: 'show fps',
  fov: 'field of view',
  r_aaSamples: 'anti-aliasing',
  sm_enable: 'shadows',
  r_specular: 'specular map',
  r_dof_enable: 'depth of field',
  r_glow_allowed: 'glow',
  r_multiGpu: 'dual video cards',
  ai_corpseCount: 'corpses',
  fx_marks: 'bullet impacts',
  r_gfxopt_dynamic_foliage: 'dynamic foliage',
  r_gfxopt_water_simulation: 'ocean simulation',
  r_texFilterAnisoMin: 'anisotropy',
  r_texFilterMipMode: 'mipmaps',
  r_picmip_manual: 'texture quality',
  r_picmip: 'texture detail',
  r_picmip_bump: 'normal map detail',
  r_picmip_spec: 'specular map detail',
  snd_menu_master: 'master',
  snd_menu_music: 'music',
  snd_menu_sfx: 'effects',
  snd_menu_voice: 'voice',
  snd_cinematicVolumeScale: 'cinematics',
  snd_losOcclusion: 'line of sight occlusion',
  sensitivity: 'sensitivity',
  ui_mousePitch: 'invert mouse',
  m_filter: 'smooth mouse',
  cl_freelook: 'free look',
  rawMouse: 'raw input',
  discordPresence: 'rich presence',
  discordOverlay: 'discord overlay',
  notifySound: 'notification sound',
  cg_mature: 'mature content',
  cg_subtitles: 'subtitles',
  hud_enable: 'hud',
  cg_drawCrosshair: 'crosshair',
  monkeytoy: 'console',
}

// One line, only where the value does not explain itself.
export const HINTS = {
  r_aaSamples: 'above 2x can hang on alt-tab',
  r_multiGpu: 'off: on a single GPU it breaks skinned models and stutters',
  r_picmip_manual: 'manual unlocks the three below',
  snd_losOcclusion: 'muffles sounds behind walls',
  rawMouse: 'fixes high polling rate mice',
  discordOverlay: 'auto turns it off when a map is short of memory',
  notifySound: 'invites, DMs and party chat while the launcher is not in front',
}

// Shorter words for the segmented buttons, keyed by item id then stored value.
export const OPTION_WORDS = {
  r_aspectRatio: { auto: 'auto', standard: '4:3', 'wide 16:10': '16:10', 'wide 16:9': '16:9' },
  r_texFilterMipMode: { Unchanged: 'auto', 'Force Bilinear': 'bilinear', 'Force Trilinear': 'trilinear' },
  r_picmip_manual: { 0: 'auto', 1: 'manual' },
  maxFps: { 250: '250' },
  discordOverlay: { auto: 'auto', allow: 'on', refuse: 'off' },
}

export const labelOf = (it) => LABELS[it.id] || String(it.label).toLowerCase()

// Old hashes (/settings#texture etc., from the WaW-menu layout) still land somewhere.
export const OLD_HASH = {
  graphics: 'graphics', texture: 'graphics', sound: 'audio', game: 'game',
  look: 'controls', move: 'controls', combat: 'controls', interact: 'controls', enw: 'enw',
}

const byId = new Map(ALL.map((i) => [i.id, i]))
export const groupItems = (g) => g.items.map((id) => byId.get(id)).filter(Boolean)
export const groupsOf = (tab) => GROUPS.filter((g) => g.tab === tab)
