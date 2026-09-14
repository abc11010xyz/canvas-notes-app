import './style.css'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<main class="app-shell">
  <header class="toolbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span>Canvas Notes</span>
    </div>
    <div class="toolbar-actions">
      <span class="sync-status" id="sync-status" aria-live="polite"></span>
      <button class="toolbar-button" id="add-note" type="button" aria-label="Add note">＋</button>
      <button class="save-button" id="save-notes" type="button">Save</button>
      <button class="account-button" id="google-sign-in" type="button">Login</button>
    </div>
  </header>
  <section class="workspace" aria-label="Note canvas">
    <div class="canvas-content">
      <div class="canvas-grid" aria-hidden="true"></div>
      <div class="notes"></div>
    </div>
  </section>
</main>
`

const workspace = document.querySelector<HTMLElement>('.workspace')!
const canvasContent = document.querySelector<HTMLElement>('.canvas-content')!
const notes = document.querySelector<HTMLElement>('.notes')!
const addNoteButton = document.querySelector<HTMLButtonElement>('#add-note')!
const saveButton = document.querySelector<HTMLButtonElement>('#save-notes')!
const storageKey = 'canvas-notes-state'
const explicitLogoutKey = 'canvas-notes-explicit-logout'
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
const signInButton = document.querySelector<HTMLButtonElement>('#google-sign-in')!
const syncStatus = document.querySelector<HTMLElement>('#sync-status')!

type SavedNote = {
  id: string
  text: string
  x: number
  y: number
  width: number
  height: number
}

type SavedState = {
  updatedAt?: string
  offsetX: number
  offsetY: number
  zoom: number
  notes: SavedNote[]
}

let offsetX = 0
let offsetY = 0
let zoom = 1
let dragStartX = 0
let dragStartY = 0
let isDragging = false
let activeCanvasPointerId: number | null = null
let accessToken: string | null = null
let driveConnected = false
let driveFileId: string | null = null
let syncStatusTimer: number | undefined
let isDirty = false
let nextNoteZIndex = 1

type GoogleTokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

type GoogleApi = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (response: { access_token?: string; error?: string }) => void
      }) => GoogleTokenClient
      revoke: (token: string, callback?: () => void) => void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleApi
  }
}

const updateAuthButton = () => {
  signInButton.textContent = accessToken ? 'Logout' : 'Login'
  signInButton.classList.toggle('is-signed-in', Boolean(accessToken))
  addNoteButton.disabled = !accessToken || !driveConnected
  saveButton.disabled = !accessToken || !driveConnected || !isDirty
}

const setEditingEnabled = (enabled: boolean) => {
  notes.querySelectorAll<HTMLTextAreaElement>('textarea').forEach((textarea) => {
    textarea.disabled = !enabled
  })
  notes.querySelectorAll<HTMLButtonElement>('.note-delete').forEach((button) => {
    button.disabled = !enabled
  })
  notes.classList.toggle('is-read-only', !enabled)
}

const setDriveConnected = (connected: boolean) => {
  driveConnected = connected
  setEditingEnabled(connected)
  updateAuthButton()
}

const setSyncStatus = (message: string, hideAfterMs = 0) => {
  window.clearTimeout(syncStatusTimer)
  syncStatus.textContent = message
  syncStatus.classList.toggle('is-unsaved', message === 'Unsaved changes')
  if (hideAfterMs > 0) {
    syncStatusTimer = window.setTimeout(() => {
      syncStatus.textContent = ''
      syncStatus.classList.remove('is-unsaved')
    }, hideAfterMs)
  }
}

const requestGoogleAccessToken = (prompt?: string) => {
  if (!clientId || !window.google) {
    signInButton.textContent = 'Setup required'
    return
  }

  if (prompt !== '') {
    localStorage.removeItem(explicitLogoutKey)
  }

  const tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (response) => {
      if (response.access_token) {
        localStorage.removeItem(explicitLogoutKey)
        accessToken = response.access_token
        setDriveConnected(false)
        updateAuthButton()
        void loadFromDrive()
      } else if (response.error && prompt !== '') {
        setSyncStatus('Failed', 7000)
      }
    },
  })

  tokenClient.requestAccessToken(prompt === undefined ? undefined : { prompt })
}

signInButton.addEventListener('click', async () => {
  if (accessToken) {
    if (isDirty) {
      const shouldSave = window.confirm('You have unsaved changes. Save before logging out?')
      if (shouldSave) {
        const localState = readLocalState()
        if (!localState || !(await saveToDrive(localState))) return
        isDirty = false
      } else if (!window.confirm('Discard unsaved changes and log out?')) {
        return
      }
    }

    const token = accessToken
    accessToken = null
    setDriveConnected(false)
    driveFileId = null
    notes.replaceChildren()
    localStorage.removeItem(storageKey)
    isDirty = false
    localStorage.setItem(explicitLogoutKey, 'true')
    window.google?.accounts.oauth2.revoke(token, updateAuthButton)
    updateAuthButton()
    setSyncStatus('')
    return
  }

  requestGoogleAccessToken()
})

saveButton.addEventListener('click', async () => {
  if (!accessToken || !driveConnected || !isDirty) return

  const localState = readLocalState()
  if (!localState) {
    setSyncStatus('Failed', 7000)
    return
  }

  if (await saveToDrive(localState)) {
    isDirty = false
    setSyncStatus('Saved', 2500)
    updateAuthButton()
  }
})

updateAuthButton()
setEditingEnabled(false)
setSyncStatus('')

window.addEventListener('load', () => {
  if (!accessToken && localStorage.getItem(explicitLogoutKey) !== 'true') {
    requestGoogleAccessToken('')
  }
})

window.addEventListener('beforeunload', (event) => {
  if (!isDirty) return

  event.preventDefault()
  event.returnValue = ''
})

const updateCanvasPosition = () => {
  canvasContent.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`
}

workspace.addEventListener('pointerdown', (event) => {
  if (event.button !== 1) return

  event.preventDefault()
  isDragging = true
  activeCanvasPointerId = event.pointerId
  dragStartX = event.clientX - offsetX
  dragStartY = event.clientY - offsetY
  workspace.setPointerCapture(event.pointerId)
  workspace.classList.add('is-dragging')
})

workspace.addEventListener('pointermove', (event) => {
  if (!isDragging) return

  offsetX = event.clientX - dragStartX
  offsetY = event.clientY - dragStartY
  updateCanvasPosition()
})

workspace.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()

    const bounds = workspace.getBoundingClientRect()
    const pointerX = event.clientX - bounds.left
    const pointerY = event.clientY - bounds.top
    const worldX = (pointerX - offsetX) / zoom
    const worldY = (pointerY - offsetY) / zoom
    const nextZoom = Math.min(3, Math.max(0.35, zoom * (event.deltaY < 0 ? 1.1 : 0.9)))

    offsetX = pointerX - worldX * nextZoom
    offsetY = pointerY - worldY * nextZoom
    zoom = nextZoom
    updateCanvasPosition()
    saveState()
  },
  { passive: false },
)

const stopDragging = (event: PointerEvent) => {
  if (!isDragging || event.pointerId !== activeCanvasPointerId) return

  isDragging = false
  activeCanvasPointerId = null
  if (workspace.hasPointerCapture(event.pointerId)) {
    workspace.releasePointerCapture(event.pointerId)
  }
  workspace.classList.remove('is-dragging')
  saveState()
}

workspace.addEventListener('pointerup', stopDragging)
workspace.addEventListener('pointercancel', stopDragging)
workspace.addEventListener('lostpointercapture', () => {
  isDragging = false
  activeCanvasPointerId = null
  workspace.classList.remove('is-dragging')
})
window.addEventListener('pointerup', stopDragging)
window.addEventListener('pointercancel', stopDragging)

const saveState = () => {
  const savedNotes = Array.from(notes.querySelectorAll<HTMLElement>('.note')).map((note) => ({
    id: note.dataset.id ?? crypto.randomUUID(),
    text: note.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '',
    x: Number.parseFloat(note.style.left),
    y: Number.parseFloat(note.style.top),
    width: note.offsetWidth,
    height: note.offsetHeight,
  }))

  const state: SavedState = {
    updatedAt: new Date().toISOString(),
    offsetX,
    offsetY,
    zoom,
    notes: savedNotes,
  }
  if (accessToken) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state))
      isDirty = true
      updateAuthButton()
      setSyncStatus('Unsaved changes')
    } catch {
      setSyncStatus('Failed', 7000)
    }
  }
}

const driveRequest = async (url: string, options: RequestInit = {}) => {
  if (!accessToken) throw new Error('Google login is required')

  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, { ...options, headers })
  if (response.status === 401) {
    accessToken = null
    driveFileId = null
    setDriveConnected(false)
    updateAuthButton()
  }
  return response
}

const readLocalState = () => {
  try {
    const cachedState = localStorage.getItem(storageKey)
    return cachedState ? (JSON.parse(cachedState) as SavedState) : null
  } catch {
    return null
  }
}

const findDriveFile = async () => {
  if (driveFileId) return driveFileId

  const query = encodeURIComponent("name = 'canvas-notes.json' and trashed = false")
  const response = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name)&pageSize=1`,
  )
  if (!response.ok) throw new Error('Unable to find the Drive file')

  const result = (await response.json()) as { files?: Array<{ id: string }> }
  driveFileId = result.files?.[0]?.id ?? null
  return driveFileId
}

const saveToDrive = async (state: SavedState) => {
  try {
    setSyncStatus('Saving...')
    const fileId = await findDriveFile()
    const metadata = fileId
      ? { name: 'canvas-notes.json', mimeType: 'application/json' }
      : { name: 'canvas-notes.json', mimeType: 'application/json' }
    const boundary = `canvas-notes-${crypto.randomUUID()}`
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      JSON.stringify(state),
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
    const response = await driveRequest(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    if (!response.ok) throw new Error('Unable to save to Drive')

    if (!fileId) {
      const created = (await response.json()) as { id?: string }
      driveFileId = created.id ?? null
    }
      setSyncStatus('Saved', 2500)
    return true
  } catch {
    setDriveConnected(false)
    setSyncStatus('Failed', 7000)
    return false
  }
}

const loadFromDrive = async () => {
  try {
    const fileId = await findDriveFile()
    if (!fileId) {
      const localState = readLocalState()
      if (localState) {
        notes.replaceChildren()
        offsetX = Number.isFinite(localState.offsetX) ? localState.offsetX : 0
        offsetY = Number.isFinite(localState.offsetY) ? localState.offsetY : 0
        zoom = Number.isFinite(localState.zoom) ? Math.min(3, Math.max(0.35, localState.zoom)) : 1
        updateCanvasPosition()
        localState.notes?.forEach((savedNote) => createNote(savedNote.x, savedNote.y, savedNote, false))
        isDirty = true
        setDriveConnected(true)
        setSyncStatus('Unsaved changes')
      } else {
        isDirty = false
        setDriveConnected(true)
      }
      return
    }

    const response = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)
    if (!response.ok) throw new Error('Unable to load from Drive')

    const state = (await response.json()) as SavedState
    const localState = readLocalState()
    const localUpdatedAt = Date.parse(localState?.updatedAt ?? '')
    const driveUpdatedAt = Date.parse(state.updatedAt ?? '')
    const stateToUse = localUpdatedAt > driveUpdatedAt && localState ? localState : state

    notes.replaceChildren()
    offsetX = Number.isFinite(stateToUse.offsetX) ? stateToUse.offsetX : 0
    offsetY = Number.isFinite(stateToUse.offsetY) ? stateToUse.offsetY : 0
    zoom = Number.isFinite(stateToUse.zoom) ? Math.min(3, Math.max(0.35, stateToUse.zoom)) : 1
    updateCanvasPosition()
    stateToUse.notes?.forEach((savedNote) => createNote(savedNote.x, savedNote.y, savedNote, false))

    if (stateToUse === localState) {
      isDirty = true
      setDriveConnected(true)
      setSyncStatus('Unsaved changes')
    } else {
      try {
        localStorage.setItem(storageKey, JSON.stringify(state))
      } catch {
        setSyncStatus('Failed', 7000)
      }
      isDirty = false
      setDriveConnected(true)
    }
  } catch {
    setDriveConnected(false)
    setSyncStatus('Failed', 7000)
  }
}

window.addEventListener('offline', () => {
  if (accessToken) {
    setDriveConnected(false)
    setSyncStatus('Failed', 7000)
  }
})

window.addEventListener('online', () => {
  if (accessToken) void loadFromDrive()
})

const createNote = (x: number, y: number, savedNote?: SavedNote, persist = true) => {
  const note = document.createElement('article')
  note.className = 'note'
  note.dataset.id = savedNote?.id ?? crypto.randomUUID()
  note.style.zIndex = `${nextNoteZIndex++}`
  note.style.left = `${x}px`
  note.style.top = `${y}px`
  if (savedNote) {
    note.style.width = `${savedNote.width}px`
    note.style.height = `${savedNote.height}px`
  }
  note.innerHTML = `
    <div class="note-header">
      <span class="note-grip" aria-hidden="true">⋮⋮</span>
      <button class="note-delete" type="button" aria-label="Delete note">×</button>
    </div>
    <textarea placeholder="Write a note..."></textarea>
    <span class="note-resize-handle note-resize-top" data-edge="top" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-right" data-edge="right" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-bottom" data-edge="bottom" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-left" data-edge="left" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-top-left" data-edge="top-left" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-top-right" data-edge="top-right" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-bottom-right" data-edge="bottom-right" aria-hidden="true"></span>
    <span class="note-resize-handle note-resize-bottom-left" data-edge="bottom-left" aria-hidden="true"></span>
  `

  const deleteButton = note.querySelector<HTMLButtonElement>('.note-delete')!
  note.addEventListener('pointerdown', () => {
    note.style.zIndex = `${nextNoteZIndex++}`
  })

  deleteButton.addEventListener('click', () => {
    if (!driveConnected) return
    note.remove()
    saveState()
  })

  let noteStartX = 0
  let noteStartY = 0
  let noteLeft = x
  let noteTop = y
  let movingNote = false
  const noteHeader = note.querySelector<HTMLElement>('.note-header')!

  noteHeader.addEventListener('pointerdown', (event) => {
    if (!driveConnected) return
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return

    event.stopPropagation()
    event.preventDefault()
    note.style.zIndex = `${nextNoteZIndex++}`
    movingNote = true
    noteStartX = event.clientX
    noteStartY = event.clientY
    noteLeft = Number.parseFloat(note.style.left)
    noteTop = Number.parseFloat(note.style.top)
    noteHeader.setPointerCapture(event.pointerId)
  })

  noteHeader.addEventListener('pointermove', (event) => {
    if (!movingNote) return

    note.style.left = `${noteLeft + (event.clientX - noteStartX) / zoom}px`
    note.style.top = `${noteTop + (event.clientY - noteStartY) / zoom}px`
  })

  const stopMovingNote = (event: PointerEvent) => {
    if (!movingNote) return

    movingNote = false
    if (noteHeader.hasPointerCapture(event.pointerId)) {
      noteHeader.releasePointerCapture(event.pointerId)
    }
    saveState()
  }

  noteHeader.addEventListener('pointerup', stopMovingNote)
  noteHeader.addEventListener('pointercancel', stopMovingNote)

  const resizeHandles = note.querySelectorAll<HTMLElement>('.note-resize-handle')
  let resizingNote = false
  let resizeEdge = ''
  let resizeStartX = 0
  let resizeStartY = 0
  let resizeStartLeft = x
  let resizeStartTop = y
  let resizeStartWidth = 220
  let resizeStartHeight = 150

  resizeHandles.forEach((resizeHandle) => {
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (!driveConnected) return
      if (event.button !== 0) return

      event.stopPropagation()
      event.preventDefault()
      resizingNote = true
      resizeEdge = resizeHandle.dataset.edge ?? ''
      resizeStartX = event.clientX
      resizeStartY = event.clientY
      resizeStartLeft = Number.parseFloat(note.style.left)
      resizeStartTop = Number.parseFloat(note.style.top)
      resizeStartWidth = note.offsetWidth
      resizeStartHeight = note.offsetHeight
      resizeHandle.setPointerCapture(event.pointerId)
    })

    resizeHandle.addEventListener('pointermove', (event) => {
      if (!resizingNote) return

      const deltaX = (event.clientX - resizeStartX) / zoom
      const deltaY = (event.clientY - resizeStartY) / zoom
      let width = resizeStartWidth
      let height = resizeStartHeight
      let left = resizeStartLeft
      let top = resizeStartTop

      if (resizeEdge === 'right') width = Math.max(160, resizeStartWidth + deltaX)
      if (resizeEdge === 'bottom') height = Math.max(100, resizeStartHeight + deltaY)
      if (resizeEdge === 'left') {
        width = Math.max(160, resizeStartWidth - deltaX)
        left = resizeStartLeft + resizeStartWidth - width
      }
      if (resizeEdge === 'top') {
        height = Math.max(100, resizeStartHeight - deltaY)
        top = resizeStartTop + resizeStartHeight - height
      }
      if (resizeEdge.includes('left')) {
        width = Math.max(160, resizeStartWidth - deltaX)
        left = resizeStartLeft + resizeStartWidth - width
      }
      if (resizeEdge.includes('right')) width = Math.max(160, resizeStartWidth + deltaX)
      if (resizeEdge.includes('top')) {
        height = Math.max(100, resizeStartHeight - deltaY)
        top = resizeStartTop + resizeStartHeight - height
      }
      if (resizeEdge.includes('bottom')) height = Math.max(100, resizeStartHeight + deltaY)

      note.style.width = `${width}px`
      note.style.height = `${height}px`
      note.style.left = `${left}px`
      note.style.top = `${top}px`
    })

    const stopResizingNote = (event: PointerEvent) => {
      if (!resizingNote) return

      resizingNote = false
      resizeEdge = ''
      if (resizeHandle.hasPointerCapture(event.pointerId)) {
        resizeHandle.releasePointerCapture(event.pointerId)
      }
      saveState()
    }

    resizeHandle.addEventListener('pointerup', stopResizingNote)
    resizeHandle.addEventListener('pointercancel', stopResizingNote)
  })
  notes.append(note)
  const textarea = note.querySelector<HTMLTextAreaElement>('textarea')!
  textarea.value = savedNote?.text ?? ''
  textarea.addEventListener('input', saveState)
  textarea.disabled = !driveConnected
  deleteButton.disabled = !driveConnected
  if (!savedNote) textarea.focus()
  if (persist) saveState()
}

addNoteButton.addEventListener('click', () => {
  if (!accessToken) {
    return
  }

  const bounds = workspace.getBoundingClientRect()
  const noteWidth = 220
  const noteHeight = 150
  const centerX = (bounds.width / 2 - offsetX) / zoom - noteWidth / 2
  const centerY = (bounds.height / 2 - offsetY) / zoom - noteHeight / 2
  createNote(centerX, centerY)
})


