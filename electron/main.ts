import { app, BrowserWindow, ipcMain, shell, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import { validateExternalUrl, checkResourcePath } from './security'
import type { AppError } from '../shared/types'

// MVP: hardcoded resource whitelist. Replace with config file loader later.
const RESOURCE_BASE_DIR = path.join(app.getPath('userData'), 'resources')
const resourceWhitelist = new Map<string, string>([
  ['res-local-001', path.join(RESOURCE_BASE_DIR, 'friction-slides.pdf')],
])

let mainWindow: BrowserWindow | null = null
let maxHeight = 800

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

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

// IPC: resize window height (clamped to maxHeight)
ipcMain.on('resize-window', (event, height: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const bounds = win.getBounds()
  win.setBounds({ ...bounds, height: Math.min(Math.max(height, 200), maxHeight) })
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

  if (!fs.existsSync(result.targetPath)) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      message: `File not found: ${result.targetPath}`,
      recoverable: false,
    }
  }

  await shell.openPath(result.targetPath)
})
