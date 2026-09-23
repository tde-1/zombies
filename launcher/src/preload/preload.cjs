// The bridge between the chrome (and the wrapped site) and the launcher.
//
// Everything the site can ask for is listed here and nowhere else. The site is a web
// page — ours today, but a web page — so it gets a named, narrow API and no Node.
// `contextIsolation` is on and `nodeIntegration` is off; this file is the entire
// surface.
const { contextBridge, ipcRenderer } = require('electron')

const call = (name, ...args) => ipcRenderer.invoke(`enw:${name}`, ...args).then((r) => {
  if (r && r.ok === false) throw new Error(r.error)
  return r ? r.data : r
})

const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload)
  ipcRenderer.on(`enw:${channel}`, wrapped)
  return () => ipcRenderer.removeListener(`enw:${channel}`, wrapped)
}

contextBridge.exposeInMainWorld('enw', {
  // Who and what.
  version: 0,
  status: () => call('status'),
  // `{mock:true}` forces the fallback. Without it the launcher uses whatever the site
  // offers, which is Steam.
  signIn: (opts) => call('signIn', opts),
  signOut: () => call('signOut'),
  // Our screens are HTML in the parent window and the site is a NATIVE child view, so
  // a screen can only be shown by HIDING the site — never by covering it. Pass null
  // when the last screen closes.
  screen: (name) => call('screen', name),

  // Finding and installing the game.
  detect: (opts) => call('detect', opts),
  browse: () => call('browse'),
  validate: (dir) => call('validate', dir),
  setup: (opts) => call('setup', opts),
  uninstall: (opts) => call('uninstall', opts),
  storage: () => call('storage'),

  // The map library.
  maps: () => call('maps'),
  installMap: (bsp) => call('installMap', bsp),
  removeMap: (bsp) => call('removeMap', bsp),
  onMapProgress: (fn) => on('mapProgress', fn),
  // 0.2.11. One map's state for a Download button ({installed, installing, pct, error});
  // Settings → Installed maps (largest first, ENW's own installs only); remove several.
  // `onMapState` fires when an install starts or ends, or a map is removed.
  mapState: (bsp) => call('mapState', bsp),
  installedMaps: () => call('installedMaps'),
  removeMaps: (list) => call('removeMaps', list),
  onMapState: (fn) => on('mapState', fn),
  installViaSteam: () => call('installViaSteam'),
  getOnSteam: () => call('getOnSteam'),

  // Settings (saved to the account, applied over the top at launch).
  getSettings: () => call('getSettings'),
  setSettings: (patch) => call('setSettings', patch),
  getDisplays: () => call('getDisplays'),

  // Playing.
  play: (opts) => call('play', opts),
  // For the site's own Play Local button when it is running inside the launcher.
  // Takes a map key, or the whole /local/start response if the page already made
  // that call. web: rename freely, it is one line here.
  playLocal: (session) => call('playLocal', session),
  cancelPlay: () => call('cancelPlay'),
  closeBoot: () => call('closeBoot'),
  // The site's Resume: go back into a match this launcher already launched once.
  resumeMatch: (matchId) => call('resumeMatch', matchId),

  // The shell.
  siteNav: (what) => call('siteNav', what),
  reloadSite: (url) => call('reloadSite', url),
  setConfig: (patch) => call('setConfig', patch),
  openExternal: (url) => call('openExternal', url),
  openFolder: (which) => call('openFolder', which),

  // Updates, the player-driven lane. `checkForUpdates()` resolves with the first state
  // it reaches; everything after that (Downloading 37%, Ready to install, a failure)
  // arrives on `onUpdateStatus`, so nothing here has to poll.
  updateStatus: () => call('updateStatus'),
  checkForUpdates: () => call('checkForUpdates'),
  restartAndUpdate: () => call('restartAndUpdate'),
  // 0.2.11, the nav chip: the launch-time check finds it, Update now downloads it,
  // Later hides the chip until the next launch (`later: true` in the status).
  updateNow: () => call('updateNow'),
  updateLater: () => call('updateLater'),
  onUpdateStatus: (fn) => on('update_status', fn),

  // "Never mid-something": the site says when it is busy, and asks for a refresh
  // instead of taking one.
  setBusy: (key, busy, why) => call('setBusy', { key, busy, why }),
  requestSiteRefresh: () => call('requestSiteRefresh'),

  // The frameless window (no launcher bar since 2026-09-22): the site's nav and the
  // shell's screens draw these three buttons. `onState` hears maximise / restore.
  win: {
    minimize: () => call('winMinimize'),
    maximize: () => call('winMaximize'),
    close: () => call('winClose'),
    isMaximized: () => call('winIsMaximized'),
    onState: (fn) => on('window', fn),
  },
  // Settings and the client install are shell screens; the site opens them from its
  // account menu. 'settings' | 'firstRun'.
  openScreen: (name) => call('openScreen', name),
  onOpenScreen: (fn) => on('openScreen', fn),

  // Events.
  onBoot: (fn) => on('boot', fn),
  onBootDone: (fn) => on('boot_done', fn),
  onSetup: (fn) => on('setup', fn),
  onSession: (fn) => on('session', fn),
  onSettings: (fn) => on('settings', fn),
  onSite: (fn) => on('site', fn),
  onToast: (fn) => on('toast', fn),
  onDeepLink: (fn) => on('deeplink', fn),
})
