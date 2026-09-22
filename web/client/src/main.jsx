import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { applyTheme } from './themes'
import './theme.css'

// The theme is applied BEFORE React mounts, so the first paint is already the right colour
// rather than flashing the stylesheet default and then correcting itself.
applyTheme()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
