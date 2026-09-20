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
  signIn: () => call('signIn'),
  signOut: () => call('signOut'),

  // Finding and installing the game.
  detect: (opts) => call('detect', opts),
  browse: () => call('browse'),
  validate: (dir) => call('validate', dir),
  setup: (opts) => call('setup', opts),
  uninstall: (opts) => call('uninstall', opts),
  installViaSteam: () => call('installViaSteam'),
  getOnSteam: () => call('getOnSteam'),

  // Settings (saved to the account, applied over the top at launch).
  getSettings: () => call('getSettings'),
  setSettings: (patch) => call('setSettings', patch),

  // Playing.
  play: (opts) => call('play', opts),
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
