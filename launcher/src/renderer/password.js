// The closed-beta password prompt. It knows nothing except how to collect a string and
// hand it back; the main process owns what happens next.
const q = new URLSearchParams(location.search)
document.getElementById('site').textContent = q.get('site') || ''
if (q.get('retry') === '1') document.getElementById('bad').classList.add('on')

const send = (password) => {
  // The window's own title is the channel: the main process reads it and closes us.
  // Nothing is stored in this page, and the value never touches localStorage.
  window.enwPassword = password
  document.title = password === null ? 'enw:cancel' : 'enw:ok'
}

document.getElementById('ok').onclick = () => send(document.getElementById('pw').value)
document.getElementById('cancel').onclick = () => send(null)
document.getElementById('pw').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send(document.getElementById('pw').value)
  if (e.key === 'Escape') send(null)
})
