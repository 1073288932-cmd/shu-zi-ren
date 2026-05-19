import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(__dirname, '../.env') })
// dev: loads <project>/.env; production: env injected by shell (dotenv.config silently no-ops)

import { app, BrowserWindow, ipcMain, shell, screen, session } from 'electron'
import fs from 'fs'
import { validateExternalUrl, checkResourcePath } from './security'
import { createCatalog } from './services/resourceCatalog'
import { DeepseekAIProvider } from './services/DeepseekAIProvider'
import { validateChatMessages } from './services/validateChatMessages'
import { mapDeepseekError } from './services/mapDeepseekError'
import type { AppError } from '../shared/types'

// MVP: hardcoded resource whitelist. Replace with config file loader later.
const RESOURCE_BASE_DIR = path.join(app.getPath('home'), 'Desktop')
const resourceWhitelist = new Map<string, string>([
  ['res-local-001', path.join(RESOURCE_BASE_DIR, '苏科版初中物理八年级下册 24年审定(1).pdf')],
])

// Load resource catalog and validate local ids against whitelist
const catalog = createCatalog(path.join(__dirname, '../resources/catalog.json'))
const missingIds = catalog.validateLocalIds(resourceWhitelist)
if (missingIds.length > 0) {
  console.warn(`[resource] Missing whitelist entries for local ids: ${missingIds.join(', ')}`)
} else {
  console.log('[resource] catalog loaded, all local ids validated')
}

const deepseekProvider = new DeepseekAIProvider(process.env.DEEPSEEK_API_KEY ?? '')

let mainWindow: BrowserWindow | null = null
let maxHeight = 800
let lastResizeAt = 0

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  maxHeight = Math.floor(height * 0.8)

  const windowWidth = 320
  const windowHeight = 420
  const margin = 16

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 280,
    maxHeight,
    x: x + width - windowWidth - margin,
    y: y + height - windowHeight - margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  // Allow microphone permission for Web Speech ASR
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

// IPC: resize window height (clamped to maxHeight, throttled to 60ms)
ipcMain.on('resize-window', (event, height: unknown) => {
  if (typeof height !== 'number' || !isFinite(height) || isNaN(height) || height <= 0) return
  const now = Date.now()
  if (now - lastResizeAt < 60) return
  lastResizeAt = now
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const bounds = win.getBounds()
  win.setBounds({ ...bounds, height: Math.min(Math.max(Math.ceil(height), 200), maxHeight) })
})

// IPC: open external URL
ipcMain.handle('open-external', async (_, url: string): Promise<AppError | undefined> => {
  const error = validateExternalUrl(url)
  if (error) return error
  await shell.openExternal(url)
})

// IPC: open local resource by ID
ipcMain.handle('open-resource', async (_, resourceId: string): Promise<AppError | undefined> => {
  const result = checkResourcePath(resourceId, resourceWhitelist, RESOURCE_BASE_DIR)

  if ('error' in result) return result.error

  let realPath: string
  try {
    realPath = fs.realpathSync(result.targetPath)
  } catch {
    return { code: 'RESOURCE_NOT_FOUND', message: `File not found: ${result.targetPath}`, recoverable: false }
  }

  const normalizedBase = path.normalize(path.resolve(RESOURCE_BASE_DIR))
  const rel = path.relative(normalizedBase, realPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { code: 'RESOURCE_NOT_ALLOWED', message: `Symlink escape detected for resource "${resourceId}"`, recoverable: false }
  }

  const openError = await shell.openPath(realPath)
  if (openError) {
    return { code: 'RESOURCE_OPEN_FAILED', message: openError, recoverable: true }
  }
})

// IPC: AI chat (main-process proxied, API key never in renderer)
const AI_UNAVAILABLE_ERROR: AppError = { code: 'AI_UNAVAILABLE', message: 'AI service not configured. Set DEEPSEEK_API_KEY.', recoverable: false }
const AI_ERROR: AppError = { code: 'AI_ERROR', message: 'Internal error', recoverable: true }

ipcMain.handle('chat', async (event, messages: unknown) => {
  if (!BrowserWindow.fromWebContents(event.sender)) return AI_ERROR
  if (!process.env.DEEPSEEK_API_KEY) return AI_UNAVAILABLE_ERROR
  const validated = validateChatMessages(messages)
  if ('code' in validated) return validated
  try {
    return await deepseekProvider.chat(validated, catalog)
  } catch (err) {
    return mapDeepseekError(err)
  }
})
