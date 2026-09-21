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
  installViaSteam: () => call('installViaSteam'),
  getOnSteam: () => call('getOnSteam'),

  // Settings (saved to the account, applied over the top at launch).
  getSettings: () => call('getSettings'),
  setSettings: (patch) => call('setSettings', patch),

  // Playing.
  play: (opts) => call('play', opts),
  // For the site's own Play Local button when it is running inside the launcher.
  // Takes a map key, or the whole /local/start response if the page already made
  // that call. web: rename freely, it is one line here.
  playLocal: (session) => call('playLocal', session),
  cancelPlay: () => call('cancelPlay'),
  closeBoot: () => call('closeBoot'),

  // The shell.
  siteNav: (what) => call('siteNav', what),
  reloadSite: (url) => call('reloadSite', url),
  setConfig: (patch) => call('setConfig', patch),
  openExternal: (url) => call('openExternal', url),
  openFolder: (which) => call('openFolder', which),

  // "Never mid-something": the site says when it is busy, and asks for a refresh
  // instead of taking one.
  setBusy: (key, busy, why) => call('setBusy', { key, busy, why }),
  requestSiteRefresh: () => call('requestSiteRefresh'),

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
