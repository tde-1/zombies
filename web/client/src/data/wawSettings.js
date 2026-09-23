// World at War's own Options menus, as data. The /settings page draws itself from this,
// and the launcher's whitelist (launcher/src/main/wawcfg.js) is checked against it by a
// test in both packages, so the two cannot drift.
//
// WHERE EVERY ITEM COMES FROM (2026-09-22, read-only extraction, nothing written back):
//
//   ui.ff  = zone/english/ui.ff out of the game copy in ZombiesDev\waw-base, zlib-inflated
//            (IWffu100 header, 12 bytes, then one zlib stream). The menus are compiled into
//            it: each item's dvar name, its label's localize key and its multiDef value
//            table (32 x label ptr, 32 x string ptr, 32 x float, count, strDef) survive as
//            plain data. Menus used: options_graphics, options_graphics_texture,
//            options_sound, options_game, options_look, options_move, options_shoot,
//            options_misc, options_control_defaults.
//   cfg    = the game's own shipped .cfg files in main/iw_00.iwd and
//            main/localized_english_iw00.iwd: options_graphics_set.cfg (ui_r_* -> r_*),
//            configure.cfg (stock graphics values), default_controls.cfg (stock binds and
//            mouse dvars - it is exactly what the menu's "Set Default Controls" execs).
//   engine = the value every engine-written config.cfg on this box agrees on (8 profiles
//            under ZombiesDev\homes, none of them touched by our harness for that dvar).
//
// `def` is the game default. `null` means the game picks it itself (its "Set Recommended"
// is hardware-dependent) - the launcher then writes `reset <dvar>` into config.cfg, the
// engine's own command (the game's shipped dvar_defaults.cfg uses it), rather than
// inventing a number.
//
// `enw` is what ENW's launch baseline already sets for that dvar (launcher/src/main/
// gamecfg.js COMMUNITY_FIXES). Until the player picks something, that is what the game
// runs with, so it is what the page shows; nothing is sent for an item left alone.
//
// `to` says where a value lives in the launcher's settings:
//   'waw'   -> settings.waw[<dvar>], written to config.cfg and the command line
//   'key:x' -> an existing launcher key (settings.x) that already has its own +set
//   'bind'  -> settings.wawBinds[<command>] = [key, key]

export const SECTIONS = [
  { id: 'graphics', label: 'Graphics', menu: 'options_graphics' },
  { id: 'texture', label: 'Texture Settings', menu: 'options_graphics_texture' },
  { id: 'sound', label: 'Sound', menu: 'options_sound' },
  { id: 'game', label: 'Game Options', menu: 'options_game' },
  { id: 'look', label: 'Look', menu: 'options_look' },
  { id: 'move', label: 'Move', menu: 'options_move' },
  { id: 'combat', label: 'Combat', menu: 'options_shoot' },
  { id: 'interact', label: 'Interact', menu: 'options_misc' },
  { id: 'enw', label: 'ENW', menu: null },
]

export const COMMON_MODES = ['1280x720', '1366x768', '1600x900', '1920x1080', '2560x1080', '2560x1440', '3440x1440', '3840x2160', '1024x768', '1280x1024']
export const REFRESH_RATES = ['60 Hz', '75 Hz', '100 Hz', '120 Hz', '144 Hz', '165 Hz', '240 Hz', '360 Hz']

// ---- the items -------------------------------------------------------------------------
export const ITEMS = [
  // GRAPHICS (options_graphics, in the menu's own order)
  { id: 'resolution', section: 'graphics', label: 'Video Mode', kind: 'mode', to: 'key:resolution', dvar: 'r_mode', def: '',
    src: 'ui.ff options_graphics @MENU_VIDEO_MODE: ui_r_mode; cfg options_graphics_set.cfg "setfromdvar r_mode ui_r_mode"',
    note: 'Borderless uses the monitor\'s native size.' },
  { id: 'r_displayRefresh', section: 'graphics', label: 'Screen Refresh Rate', kind: 'select', to: 'waw', dvar: 'r_displayRefresh', def: '',
    options: [{ label: 'Auto (your display)', value: '' }, ...REFRESH_RATES.map((r) => ({ label: r, value: r }))],
    src: 'ui.ff options_graphics @MENU_SCREEN_REFRESH_RATE: ui_r_displayRefresh -> r_displayRefresh (options_graphics_set.cfg); the engine writes it as "60 Hz"',
    note: null },
  { id: 'r_aspectRatio', section: 'graphics', label: 'Aspect Ratio', kind: 'select', to: 'waw', dvar: 'r_aspectRatio', def: 'auto', enw: 'auto',
    options: [{ label: 'Auto', value: 'auto' }, { label: 'Standard 4:3', value: 'standard' }, { label: 'Wide 16:10', value: 'wide 16:10' }, { label: 'Wide 16:9', value: 'wide 16:9' }],
    src: 'ui.ff options_graphics @MENU_ASPECT_RATIO: ui_r_aspectratio multiDef (strDef) auto / standard / wide 16:10 / wide 16:9; default cfg configure.cfg' },
  { id: 'r_aaSamples', section: 'graphics', label: 'Anti-Aliasing', kind: 'select', to: 'waw', dvar: 'r_aaSamples', def: null,
    options: [{ label: 'Off', value: '1' }, { label: '2x', value: '2' }, { label: '4x', value: '4' }],
    src: 'ui.ff options_graphics @MENU_ANTIALIASING: ui_r_aasamples multiDef Off=1 2X=2 4X=4',
    note: 'Above 2x can hang on alt-tab.' },
  { id: 'r_gamma', section: 'graphics', label: 'Brightness', kind: 'slider', to: 'waw', dvar: 'r_gamma', min: 0.5, max: 3, step: 0.05, def: '1',
    src: 'ui.ff options_graphics @MENU_BRIGHTNESS: r_gamma slider min 0.5 max 3 def 1; cfg configure.cfg r_gamma "1"' },
  { id: 'vsync', section: 'graphics', label: 'Sync Every Frame', kind: 'toggle', to: 'key:vsync', dvar: 'r_vsync', def: false,
    src: 'ui.ff options_graphics @MENU_SYNC_EVERY_FRAME: ui_r_vsync -> r_vsync (options_graphics_set.cfg); cfg configure.cfg r_vsync "0"',
    note: 'On caps the frame rate at your monitor\'s refresh.' },
  { id: 'r_multiGpu', section: 'graphics', label: 'Optimize for Dual Video Cards', kind: 'toggle', to: 'waw', dvar: 'r_multiGpu', def: '0', enw: '1',
    src: 'ui.ff options_graphics @MENU_OPTIMIZE_FOR_DUAL_VIDEO_CARDS: r_multiGpu; cfg configure.cfg r_multiGpu "0"',
    note: 'Fixes stutter on modern PCs.' },
  { id: 'sm_enable', section: 'graphics', label: 'Shadows', kind: 'toggle', to: 'waw', dvar: 'sm_enable', def: null, enw: '1',
    src: 'ui.ff options_graphics @MENU_SHADOWS: sm_enable' },
  { id: 'r_specular', section: 'graphics', label: 'Specular Map', kind: 'toggle', to: 'waw', dvar: 'r_specular', def: null,
    src: 'ui.ff options_graphics @MENU_SPECULAR_MAP: r_specular' },
  { id: 'r_gfxopt_water_simulation', section: 'graphics', label: 'Ocean Simulation', kind: 'toggle', to: 'waw', dvar: 'r_gfxopt_water_simulation', def: '1',
    src: 'ui.ff options_graphics @MENU_OPTION_OCEAN_SIMILATION: r_gfxopt_water_simulation; engine default 1' },
  { id: 'r_gfxopt_dynamic_foliage', section: 'graphics', label: 'Dynamic Foliage', kind: 'toggle', to: 'waw', dvar: 'r_gfxopt_dynamic_foliage', def: '1',
    src: 'ui.ff options_graphics @MENU_OPTION_DYNAMIC_FOLIAGE: r_gfxopt_dynamic_foliage; engine default 1' },
  { id: 'fx_marks', section: 'graphics', label: 'Bullet Impacts', kind: 'toggle', to: 'waw', dvar: 'fx_marks', def: '1',
    src: 'ui.ff options_graphics @MENU_OPTION_BULLET_IMPACTS: fx_marks; engine default 1' },
  { id: 'ai_corpseCount', section: 'graphics', label: 'Number of Corpses', kind: 'select', to: 'waw', dvar: 'ai_corpseCount', def: '5',
    options: [{ label: 'Tiny', value: '3' }, { label: 'Small', value: '5' }, { label: 'Medium', value: '10' }, { label: 'Large', value: '20' }, { label: 'Insane', value: '32' }],
    src: 'ui.ff options_graphics @MENU_NUMBER_OF_CORPSES: ai_corpsecount multiDef Tiny=3 Small=5 Medium=10 Large=20 Insane=32; engine default 5' },

  // TEXTURE SETTINGS (options_graphics_texture)
  { id: 'r_texFilterMipMode', section: 'texture', label: 'Texture Mipmaps', kind: 'select', to: 'waw', dvar: 'r_texFilterMipMode', def: 'Unchanged',
    options: [{ label: 'Automatic', value: 'Unchanged' }, { label: 'Bilinear', value: 'Force Bilinear' }, { label: 'Trilinear', value: 'Force Trilinear' }],
    src: 'ui.ff options_graphics_texture @MENU_TEXTURE_MIPMAPS: r_texFilterMipMode multiDef (strDef) Unchanged / Force Bilinear / Force Trilinear; cfg configure.cfg "Unchanged"' },
  { id: 'r_texFilterAnisoMin', section: 'texture', label: 'Texture Anisotropy', kind: 'slider', to: 'waw', dvar: 'r_texFilterAnisoMin', min: 1, max: 16, step: 1, def: '1', enw: '16',
    src: 'ui.ff options_graphics_texture @MENU_TEXTURE_ANISOTROPY: r_texFilterAnisoMin slider 1-16 def 1; cfg configure.cfg "1"',
    note: null },
  { id: 'r_picmip_manual', section: 'texture', label: 'Texture Quality', kind: 'select', to: 'waw', dvar: 'r_picmip_manual', def: '0',
    options: [{ label: 'Automatic', value: '0' }, { label: 'Manual', value: '1' }],
    src: 'ui.ff options_graphics_texture @MENU_TEXTURE_QUALITY: ui_r_picmip_manual -> r_picmip_manual, multiDef 0 / @MENU_MANUAL=1; cfg configure.cfg "0"' },
  { id: 'r_picmip', section: 'texture', label: 'Texture Resolution', kind: 'select', to: 'waw', dvar: 'r_picmip', def: null, enw: '0', needsManual: true,
    options: [{ label: 'Low', value: '3' }, { label: 'Normal', value: '2' }, { label: 'High', value: '1' }, { label: 'Extra', value: '0' }],
    src: 'ui.ff options_graphics_texture @MENU_TEXTURE_RESOLUTION: ui_r_picmip multiDef Low=3 Normal=2 High=1 Extra=0; applied by apply_picmip_popmenu "setfromdvar r_picmip ui_r_picmip"' },
  { id: 'r_picmip_bump', section: 'texture', label: 'Normal Map Resolution', kind: 'select', to: 'waw', dvar: 'r_picmip_bump', def: null, enw: '0', needsManual: true,
    options: [{ label: 'Low', value: '3' }, { label: 'Normal', value: '2' }, { label: 'High', value: '1' }, { label: 'Extra', value: '0' }],
    src: 'ui.ff options_graphics_texture @MENU_NORMAL_MAP_RESOLUTION: ui_r_picmip_bump multiDef 3/2/1/0 (labels shared with Texture Resolution)' },
  { id: 'r_picmip_spec', section: 'texture', label: 'Specular Map Resolution', kind: 'select', to: 'waw', dvar: 'r_picmip_spec', def: null, enw: '0', needsManual: true,
    options: [{ label: 'Low', value: '3' }, { label: 'Normal', value: '2' }, { label: 'High', value: '1' }, { label: 'Extra', value: '0' }],
    src: 'ui.ff options_graphics_texture @MENU_SPECULAR_MAP_RESOLUTION: ui_r_picmip_spec multiDef 3/2/1/0 (labels shared with Texture Resolution)' },

  // SOUND (options_sound)
  { id: 'snd_menu_master', section: 'sound', label: 'Master Volume', kind: 'slider', to: 'waw', dvar: 'snd_menu_master', min: 0, max: 1, step: 0.05, def: '1',
    src: 'ui.ff options_sound @MENU_MASTER_VOLUME: snd_menu_master slider 0-1 def 1' },
  { id: 'snd_menu_voice', section: 'sound', label: 'Voice Volume', kind: 'slider', to: 'waw', dvar: 'snd_menu_voice', min: 0, max: 1, step: 0.05, def: '1',
    src: 'ui.ff options_sound @MENU_VOICE_VOLUME: snd_menu_voice slider 0-1 def 1' },
  { id: 'snd_menu_music', section: 'sound', label: 'Music Volume', kind: 'slider', to: 'waw', dvar: 'snd_menu_music', min: 0, max: 1, step: 0.05, def: '1',
    src: 'ui.ff options_sound @MENU_MUSIC_VOLUME: snd_menu_music slider 0-1 def 1' },
  { id: 'snd_menu_sfx', section: 'sound', label: 'Effects Volume', kind: 'slider', to: 'waw', dvar: 'snd_menu_sfx', min: 0, max: 1, step: 0.05, def: '1',
    src: 'ui.ff options_sound @MENU_SFX_VOLUME: snd_menu_sfx slider 0-1 def 1' },
  { id: 'snd_cinematicVolumeScale', section: 'sound', label: 'Cinematics Volume', kind: 'slider', to: 'waw', dvar: 'snd_cinematicVolumeScale', min: 0, max: 1, step: 0.05, def: '1',
    src: 'ui.ff options_sound @MENU_CINEMATICS_VOLUME: snd_cinematicVolumeScale slider 0-1 def 1' },
  { id: 'snd_losOcclusion', section: 'sound', label: 'Line of Sight Occlusion', kind: 'toggle', to: 'waw', dvar: 'snd_losOcclusion', def: '1',
    src: 'ui.ff options_sound @MENU_SOUND_LOSOCCLUSION: snd_losOcclusion multiDef No=0 Yes=1; engine default 1' },

  // GAME OPTIONS (options_game)
  { id: 'cg_mature', section: 'game', label: 'Mature Content', kind: 'select', to: 'waw', dvar: 'cg_mature', def: '1',
    options: [{ label: 'Unrestricted', value: '1' }, { label: 'Reduced', value: '0' }],
    also: { '1': { cg_blood: '1' } },
    src: 'ui.ff options_game @MENU_MATURE_UNRESTRICTED: "setdvar cg_mature 1 ; setdvar cg_blood 1"; @MENU_MATURE_REDUCED opens mature_content_pc_disable_warning, whose body is not in ui.ff',
    note: null },
  { id: 'monkeytoy', section: 'game', label: 'Enable Console', kind: 'select', to: 'waw', dvar: 'monkeytoy', def: null,
    options: [{ label: 'Yes', value: '0' }, { label: 'No', value: '1' }],
    src: 'ui.ff options_game @MENU_ENABLE_CONSOLE: monkeytoy multiDef Yes=0 No=1 (label pointers shared with snd_losOcclusion\'s No=0 Yes=1)' },
  { id: 'cg_subtitles', section: 'game', label: 'Subtitles', kind: 'toggle', to: 'waw', dvar: 'cg_subtitles', def: '0',
    src: 'ui.ff options_game @MENU_SUBTITLES: cg_subtitles; engine default 0' },
  { id: 'hud_enable', section: 'game', label: 'Draw HUD', kind: 'toggle', to: 'waw', dvar: 'hud_enable', def: '1',
    src: 'ui.ff options_game @MENU_DRAW_HUD: hud_enable; engine default 1' },
  { id: 'cg_drawCrosshair', section: 'game', label: 'Enable Crosshair', kind: 'toggle', to: 'waw', dvar: 'cg_drawCrosshair', def: '1',
    src: 'ui.ff options_game @MENU_ENABLE_CROSSHAIR: cg_drawCrosshair; engine default 1' },

  // LOOK (options_look)
  { id: 'ui_mousePitch', section: 'look', label: 'Invert Mouse', kind: 'toggle', to: 'waw', dvar: 'ui_mousePitch', def: '0',
    also: { '1': { m_pitch: '-0.022' }, '0': { m_pitch: '0.022' } },
    src: 'ui.ff options_look @MENU_INVERT_MOUSE: ui_mousePitch + "uiScript update ui_mousePitch" (sets m_pitch -/+0.022, as ioquake3 ui_main.c UI_Update does); cfg default_controls.cfg ui_mousePitch "0", m_pitch "0.022"' },
  { id: 'cl_freelook', section: 'look', label: 'Free Look', kind: 'toggle', to: 'waw', dvar: 'cl_freelook', def: '1',
    src: 'ui.ff options_look @MENU_FREE_LOOK: cl_freelook; cfg default_controls.cfg "1"' },
  { id: 'm_filter', section: 'look', label: 'Smooth Mouse', kind: 'toggle', to: 'waw', dvar: 'm_filter', def: '0', enw: '0',
    src: 'ui.ff options_look @MENU_SMOOTH_MOUSE: m_filter; cfg default_controls.cfg "0"' },
  { id: 'sensitivity', section: 'look', label: 'Mouse Sensitivity', kind: 'slider', to: 'key:sensitivity', dvar: 'sensitivity', min: 1, max: 30, step: 0.1, def: 5,
    src: 'ui.ff options_look @MENU_MOUSE_SENSITIVITY: sensitivity slider 1-30 def 5; cfg default_controls.cfg "5"' },
]

// Key bindings, per menu, in the menu's own order. `keys` is the default from
// default_controls.cfg - exactly what the game's "Set Default Controls" execs.
const B = (section, label, command, keys, src) => ({
  id: `bind:${command}`, section, label, kind: 'bind', to: 'bind', command, def: keys,
  src: `ui.ff ${src}; default keys cfg default_controls.cfg`,
})
export const BINDS = [
  B('look', 'Lean Left', '+leanleft', ['Q'], 'options_look @MENU_LEAN_LEFT'),
  B('look', 'Lean Right', '+leanright', ['E'], 'options_look @MENU_LEAN_RIGHT'),
  B('look', 'Look Up', '+lookup', [], 'options_look @MENU_LOOK_UP'),
  B('look', 'Look Down', '+lookdown', [], 'options_look @MENU_LOOK_DOWN'),
  B('look', 'Turn Left', '+left', [], 'options_look @MENU_TURN_LEFT'),
  B('look', 'Turn Right', '+right', [], 'options_look @MENU_TURN_RIGHT'),
  B('look', 'Mouse Look', '+mlook', [], 'options_look @MENU_MOUSE_LOOK'),
  B('look', 'Center View', 'centerview', [], 'options_look @MENU_CENTER_VIEW'),
  B('move', 'Forward', '+forward', ['W'], 'options_move @MENU_FORWARD'),
  B('move', 'Backpedal', '+back', ['S'], 'options_move @MENU_BACKPEDAL'),
  B('move', 'Move Left', '+moveleft', ['A'], 'options_move @MENU_MOVE_LEFT'),
  B('move', 'Move Right', '+moveright', ['D'], 'options_move @MENU_MOVE_RIGHT'),
  B('move', 'Stand / Jump', '+gostand', ['SPACE'], 'options_move @MENU_STANDJUMP'),
  B('move', 'Go to Crouch', 'gocrouch', ['C'], 'options_move @MENU_GO_TO_CROUCH'),
  B('move', 'Go to Prone', 'goprone', ['CTRL'], 'options_move @MENU_GO_TO_PRONE'),
  B('move', 'Toggle Crouch', 'togglecrouch', [], 'options_move @MENU_TOGGLE_CROUCH'),
  B('move', 'Toggle Prone', 'toggleprone', [], 'options_move @MENU_TOGGLE_PRONE'),
  B('move', 'Crouch', '+movedown', [], 'options_move @MENU_CROUCH'),
  B('move', 'Prone', '+prone', [], 'options_move @MENU_PRONE'),
  B('move', 'Change Stance', '+stance', [], 'options_move "Change Stance"'),
  B('move', 'Strafe', '+strafe', [], 'options_move @MENU_STRAFE'),
  B('combat', 'Attack', '+attack', ['MOUSE1'], 'options_shoot @MENU_ATTACK'),
  // ENW exception, B 2026-09-22: aim down sights is HOLD. The stock file binds MOUSE2 to the
  // toggle; ENW's launcher baseline moves it, so "game defaults" here keep ENW's hold.
  B('combat', 'Aim Down the Sight', '+speed_throw', ['MOUSE2'], 'options_shoot @MENU_AIM_DOWN_THE_SIGHT'),
  B('combat', 'Toggle Aim Down the Sight', '+toggleads_throw', [], 'options_shoot @MENU_TOGGLE_AIM_DOWN_THE_SIGHT'),
  B('combat', 'Melee Attack', '+melee', ['V'], 'options_shoot @MENU_MELEE_ATTACK'),
  B('combat', 'Switch Weapon', 'weapnext', ['1', 'MWHEELDOWN'], 'options_shoot @MENU_SWITCH_WEAPON'),
  B('combat', 'Reload Weapon', '+reload', ['R'], 'options_shoot @MENU_RELOAD_WEAPON'),
  B('combat', 'Sprint', '+sprint', [], 'options_shoot @MENU_SPRINT'),
  B('combat', 'Sprint / Hold Breath', '+breath_sprint', ['SHIFT'], 'options_shoot @MENU_SPRINT_HOLD_BREATH'),
  B('combat', 'Steady Sniper Rifle', '+holdbreath', [], 'options_shoot @MENU_STEADY_SNIPER_RIFLE'),
  B('combat', 'Throw Frag Grenade', '+frag', ['MOUSE3', 'G'], 'options_shoot @MENU_THROW_FRAG_GRENADE'),
  B('combat', 'Throw Special Grenade', '+smoke', ['4'], 'options_shoot @MENU_THROW_SPECIAL_GRENADE'),
  B('combat', 'Inventory / Rifle Grenade', '+actionslot 3', ['5'], 'options_shoot @MENU_ACTION_INVENTORY, @MPUI_RIFLE_GRENADE'),
  B('combat', 'Equipment / Ground Support', '+actionslot 4', ['6'], 'options_shoot @MENU_GROUND_SUPPORT, @MENU_EQUIPMENT'),
  B('combat', 'Satchel Charge', '+actionslot 2', ['7'], 'options_shoot @MENU_SATCHEL_CHARGE'),
  B('interact', 'Use', '+activate', ['F'], 'options_misc @MENU_USE'),
  B('interact', 'Map', '+actionslot 1', ['X'], 'options_misc @MENU_MAP'),
  B('interact', 'Screenshot', 'screenshotjpeg', ['F12'], 'options_misc @MENU_SCREENSHOT'),
  B('interact', 'Show Objectives / Scores', '+scores', ['TAB'], 'options_misc @MENU_SHOW_OBJECTIVES_SCORES'),
  B('interact', 'Accept Invite', 'acceptInvitation', ['F10'], 'options_misc @MENU_ACCEPT_INVITE'),
  B('interact', 'Quick Save', 'savegame_lastcommit', ['F5'], 'options_misc @MENU_QUICK_SAVE'),
]

// ENW's own knobs: not in World at War's menus, each already wired in the launcher.
export const ENW_ITEMS = [
  { id: 'mode', section: 'enw', label: 'Display Mode', kind: 'select', to: 'key:mode', def: 'borderless',
    options: [{ label: 'Borderless', value: 'borderless' }, { label: 'Fullscreen', value: 'fullscreen' }, { label: 'Windowed', value: 'windowed' }],
    src: 'launcher: r_fullscreen + the client DLL\'s borderless component (client.md 2c). WaW\'s menu has no display-mode item.' },
  { id: 'display', section: 'enw', label: 'Monitor', kind: 'monitor', to: 'key:display', def: 'primary',
    src: 'launcher: r_monitor + vid_xpos/vid_ypos from the chosen display (launcher.md, launch baseline)' },
  { id: 'fov', section: 'enw', label: 'Field of View', kind: 'slider', to: 'key:fov', dvar: 'cg_fov', min: 65, max: 120, step: 1, def: 80,
    src: 'launcher: cg_fov, clamped 65-120 (spec 4.5). Not in WaW\'s menus; ENW default 80' },
  { id: 'maxFps', section: 'enw', label: 'Max FPS', kind: 'select', to: 'key:maxFps', dvar: 'com_maxfps', def: 250,
    options: [{ label: '60', value: 60 }, { label: '85', value: 85 }, { label: '125', value: 125 }, { label: '250 (ENW cap)', value: 250 }],
    src: 'launcher: com_maxfps, capped at 250 (spec 4.5). Divisors of 1000 only - the Q3 lineage stutters on anything else (client.md 5c)' },
  { id: 'showFps', section: 'enw', label: 'Show FPS', kind: 'toggle', to: 'key:showFps', dvar: 'cg_drawFPS', def: false,
    src: 'launcher: cg_drawFPS "Simple" / "Off" (an enum on T4, launcher.md 0.2.3)' },
  { id: 'rawMouse', section: 'enw', label: 'Raw Mouse Input', kind: 'toggle', to: 'key:rawMouse', def: true,
    src: 'client DLL mouse_polling (client.md 1, 5): ENW_RAW_MOUSE=0 in the environment turns it off' },
  { id: 'discordPresence', section: 'enw', label: 'Discord Rich Presence', kind: 'toggle', to: 'key:discordPresence', def: true,
    src: 'launcher: discord.js (launcher.md "Discord rich presence"). Off clears it at once. Not a game setting.' },
  { id: 'r_dof_enable', section: 'enw', label: 'Depth of Field', kind: 'toggle', to: 'waw', dvar: 'r_dof_enable', def: '1',
    src: 'engine dvar, archived in the config.cfg the game writes (seta r_dof_enable "1" on every profile here). Not in WaW\'s menus.' },
  { id: 'r_glow_allowed', section: 'enw', label: 'Glow', kind: 'toggle', to: 'waw', dvar: 'r_glow_allowed', def: null,
    src: 'engine dvar, archived in the config.cfg the game writes. Not in WaW\'s menus.' },
]

export const ALL = [...ITEMS, ...BINDS, ...ENW_ITEMS]

// Everything the page offers that a game menu has and we do NOT map, and why.
export const OMITTED = [
  { label: 'Speaker Configuration (Stereo / 5.1 / 7.1)', why: 'options_sound drives it through ui_outputConfig and engine-evaluated visibility expressions that were not decoded; the game auto-detects it and forcing it is PCGamingWiki\'s documented way to break sound.' },
  { label: 'Voice chat, Multiplayer and Co-op option pages', why: 'Online options for Activision\'s own co-op and multiplayer. ENW games do not use them.' },
  { label: 'Chat keys (chatmodepublic, +talk), Previous Weapon (weapprev)', why: 'Bound by default_controls.cfg but not items in any Options menu.' },
  { label: 'Graphics "Set Recommended" / Apply buttons', why: 'Engine UI scripts (setRecommended, vid_restart). The launcher applies everything at the next launch instead.' },
]

// ---- values ----------------------------------------------------------------------------

// The game defaults for one section, as a partial `game` object.
export function sectionDefaults(section) {
  return defaultsFor(ALL.filter((it) => it.section === section))
}

// The game defaults for any list of items (the /settings page resets its own smaller
// groups with this - data/settingsLayout.js), as a partial `game` object.
export function defaultsFor(items) {
  const game = { waw: {}, wawBinds: {} }
  for (const it of items) {
    if (it.to === 'waw') {
      game.waw[it.dvar] = it.def
      const extra = it.also && it.def != null ? it.also[String(it.def)] : null
      if (extra) Object.assign(game.waw, extra)
    } else if (it.to === 'bind') {
      game.wawBinds[it.command] = [...it.def]
    } else if (it.to.startsWith('key:')) {
      game[it.to.slice(4)] = it.def
    }
  }
  return game
}

export function allDefaults() {
  const out = { waw: {}, wawBinds: {} }
  for (const s of SECTIONS) {
    const { waw, wawBinds, ...keys } = sectionDefaults(s.id)
    Object.assign(out, keys)
    Object.assign(out.waw, waw)
    Object.assign(out.wawBinds, wawBinds)
  }
  return out
}

// What the game will actually run with for an item: the player's choice, else ENW's
// baseline, else the game default.
export function shownValue(game, it) {
  const v = valueOf(game, it)
  if (v !== undefined && v !== '') return v
  if (it.enw !== undefined) return it.enw
  return it.def
}

// Read one item's current value out of a `game` object ('' = no opinion yet).
export function valueOf(game, it) {
  if (it.to === 'waw') {
    const w = (game && game.waw) || {}
    return Object.prototype.hasOwnProperty.call(w, it.dvar) ? w[it.dvar] : undefined
  }
  if (it.to === 'bind') {
    const b = (game && game.wawBinds) || {}
    return Object.prototype.hasOwnProperty.call(b, it.command) ? b[it.command] : undefined
  }
  return game ? game[it.to.slice(4)] : undefined
}

// Write one item into a copy of `game`, including any dvars the game's own menu script
// sets alongside it (Mature -> cg_blood, Invert Mouse -> m_pitch).
export function withValue(game, it, value) {
  const g = { ...(game || {}), waw: { ...((game && game.waw) || {}) }, wawBinds: { ...((game && game.wawBinds) || {}) } }
  if (it.to === 'waw') {
    g.waw[it.dvar] = value
    const extra = it.also && value != null ? it.also[String(value)] : null
    if (extra) Object.assign(g.waw, extra)
  } else if (it.to === 'bind') {
    // A key holds one command, as in the game: taking it here frees it everywhere else.
    const keys = (value || []).map((k) => String(k).toUpperCase()).slice(0, 2)
    for (const [cmd, ks] of Object.entries(g.wawBinds)) {
      if (cmd === it.command) continue
      const left = (ks || []).filter((k) => !keys.includes(String(k).toUpperCase()))
      if (left.length !== (ks || []).length) g.wawBinds[cmd] = left
    }
    g.wawBinds[it.command] = keys
  } else {
    g[it.to.slice(4)] = value
  }
  return g
}

// The object the launcher's `settings.set()` takes (window.enw.setSettings). Every
// catalogue dvar is sent explicitly: a value, `null` (game default: `reset <dvar>`), or
// '' (no opinion: the launcher stops writing it).
export const LAUNCHER_KEYS = ['mode', 'display', 'resolution', 'vsync', 'fov', 'maxFps', 'showFps', 'sensitivity', 'rawMouse', 'discordPresence']
export function toLauncherPatch(game) {
  const g = game || {}
  const out = {}
  for (const k of LAUNCHER_KEYS) if (g[k] !== undefined) out[k] = g[k]
  out.waw = {}
  for (const it of ALL) {
    if (it.to !== 'waw') continue
    const v = valueOf(g, it)
    out.waw[it.dvar] = v === undefined ? '' : v
    if (it.also) for (const extra of Object.values(it.also)) for (const d of Object.keys(extra)) if (!(d in out.waw)) out.waw[d] = g.waw && d in g.waw ? g.waw[d] : ''
  }
  out.wawBinds = {}
  for (const it of BINDS) {
    const v = valueOf(g, it)
    if (v !== undefined) out.wawBinds[it.command] = v
  }
  out.gameUpdatedAt = Number(g.updatedAt) || 0
  return out
}

// The launcher's settings back into a `game` object (the reverse of toLauncherPatch).
export function fromLauncher(s) {
  const g = { waw: { ...((s && s.waw) || {}) }, wawBinds: { ...((s && s.wawBinds) || {}) } }
  for (const k of LAUNCHER_KEYS) if (s && s[k] !== undefined && s[k] !== null) g[k] = s[k]
  g.updatedAt = Number(s && s.gameUpdatedAt) || 0
  return g
}

// Which copy wins: the newer one. Returns 'site', 'launcher' or 'same'.
export function newer(siteGame, launcherSettings) {
  const a = Number(siteGame && siteGame.updatedAt) || 0
  const b = Number(launcherSettings && launcherSettings.gameUpdatedAt) || 0
  if (a === b) return 'same'
  return a > b ? 'site' : 'launcher'
}

// Key names the engine understands in a bind line, for the capture box.
export function keyName(e) {
  const k = e.key
  if (e.button !== undefined && e.type === 'mousedown') return ['MOUSE1', 'MOUSE3', 'MOUSE2', 'MOUSE4', 'MOUSE5'][e.button] || null
  if (e.type === 'wheel') return e.deltaY < 0 ? 'MWHEELUP' : 'MWHEELDOWN'
  const map = {
    ' ': 'SPACE', Shift: 'SHIFT', Control: 'CTRL', Alt: 'ALT', Tab: 'TAB', Enter: 'ENTER', Backspace: 'BACKSPACE',
    ArrowUp: 'UPARROW', ArrowDown: 'DOWNARROW', ArrowLeft: 'LEFTARROW', ArrowRight: 'RIGHTARROW',
    Insert: 'INS', Delete: 'DEL', Home: 'HOME', End: 'END', PageUp: 'PGUP', PageDown: 'PGDN', Pause: 'PAUSE', CapsLock: 'CAPSLOCK',
  }
  if (map[k]) return map[k]
  if (/^F\d{1,2}$/.test(k)) return k
  if (e.code && /^Numpad\d$/.test(e.code)) return `KP_${e.code.slice(6)}`
  if (k && k.length === 1 && /[!-~]/.test(k)) return k.toUpperCase()
  return null
}
