import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'fs';
import path from 'path';

let mainWindow: BrowserWindow | null = null;
const liveWindows = new Map<string, BrowserWindow>();

// ── Realtime / Deepgram WebSocket bridges ─────────────────────────────────────
// The renderer cannot attach custom headers to a browser WebSocket.
// Both OpenAI Realtime (Authorization: Bearer) and Deepgram (Authorization: Token)
// are handled here in the main process using the `ws` Node package so the API
// keys are set directly on the socket and never appear in renderer network traffic.
// Audio chunks arrive via IPC; transcript/command events are pushed back the same way.
//
// ws is loaded lazily (inside the handler, not at module level) so a missing
// package cannot crash main.js and prevent all other IPC handlers from
// registering.  Add ws as a direct dependency if needed: npm install ws

let realtimeWs: any = null;
let realtimeWsOwner: Electron.WebContents | null = null;

// ── Deepgram WS state ──────────────────────────────────────────────────────────
let deepgramWs: any = null;
let deepgramWsOwner: Electron.WebContents | null = null;

function closeDeepgramWs(): void {
  if (deepgramWs) {
    try { deepgramWs.close(); } catch { /* ignore */ }
    deepgramWs = null;
  }
  deepgramWsOwner = null;
}

function closeRealtimeWs(): void {
  if (realtimeWs) {
    try { realtimeWs.close(); } catch { /* ignore */ }
    realtimeWs = null;
  }
  realtimeWsOwner = null;
}

/** Lazy-load `ws` so a missing module cannot crash module initialisation. */
function loadWsClass(): { WS: any; error?: undefined } | { WS?: undefined; error: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WS = require('ws');
    return { WS };
  } catch (err: any) {
    console.error('[RealtimeWS] Failed to load ws module:', err.message);
    console.error('[RealtimeWS] Fix: run  npm install ws  in the project root');
    return { error: `ws module not available: ${err.message}. Run: npm install ws` };
  }
}

const isDev = process.env.NODE_ENV === 'development';

/**
 * Returns the Vite dev server base URL.
 *
 * Vite's writeDevServerUrl plugin writes the actual URL (with whatever port
 * Vite chose) to dist-electron/.dev-server-url every time the dev server
 * starts.  We read that file so the port is never hardcoded — it works
 * whether Vite ended up on 3000, 3001, 3002, or any other port.
 *
 * Falls back to the VITE_DEV_SERVER_URL env var, then to localhost:3000.
 */
function getDevServerUrl(): string {
  try {
    const urlFile = path.join(__dirname, '.dev-server-url');
    return fs.readFileSync(urlFile, 'utf-8').trim();
  } catch {
    return process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:3000';
  }
}

// Resolved once at startup — all windows share the same dev server.
const DEV_SERVER_URL = isDev ? getDevServerUrl() : '';

// ── NDI state ─────────────────────────────────────────────────────
// NDI uses an offscreen BrowserWindow that renders scripture via live.html
// and feeds paint-event BGRA frames directly into the NDI SDK.
// No visible window or capturePage polling needed.

const NDI_WINDOW_ID = '__ndi__';   // key in liveWindows for the hidden NDI renderer
let ndiSender: any = null;
let ndiGrandiose: any = null;      // cached after first successful load
let ndiLoadError: string | null = null;  // last error from require('grandiose')

// Known NDI Runtime install locations on Windows.
// The packaged app may not inherit the user's PATH, so we prepend these
// directories before attempting to load grandiose so Windows can resolve
// Processing.NDI.Lib.x64.dll even if it isn't in the process PATH.
// IMPORTANT: NDI 6 Tools paths must come first — grandiose bundles a
// stale NDI v3 DLL that uses an incompatible discovery protocol. By
// injecting the NDI 6 Tools runtime directory into PATH before requiring
// grandiose, Windows finds the v6 DLL from PATH (after the CI build step
// has removed the bundled v3 DLL from grandiose's build/Release/ dir).
const NDI_RUNTIME_PATHS = [
  'C:\\Program Files\\NDI\\NDI 6 Tools\\Runtime',
  'C:\\Program Files\\NDI\\NDI 6 Tools\\Router',
  'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6',
  'C:\\Program Files\\NDI\\NDI 6 Runtime',
  'C:\\Program Files\\NDI\\NDI 5 Runtime',
  'C:\\Program Files\\NewTek\\NewTek NDI Tools',
  'C:\\Program Files\\NewTek\\NDI 4 Runtime\\v4.6',
];

function injectNDIRuntimePaths(): void {
  const existing = process.env.PATH ?? '';
  const toAdd = NDI_RUNTIME_PATHS
    .filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    })
    .filter(p => !existing.includes(p));

  if (toAdd.length > 0) {
    process.env.PATH = toAdd.join(';') + ';' + existing;
    console.log(`[NDI] Injected runtime paths: ${toAdd.join(', ')}`);
  }
}

function loadGrandiose(): any {
  if (ndiGrandiose) return ndiGrandiose;
  // Ensure NDI Runtime DLLs are findable before the first require()
  injectNDIRuntimePaths();
  try {
    ndiGrandiose = require('grandiose');
    ndiLoadError = null;
    console.log('[NDI] grandiose loaded successfully');
    return ndiGrandiose;
  } catch (err: any) {
    ndiLoadError = err.message ?? String(err);
    console.error(`[NDI] grandiose failed to load: ${ndiLoadError}`);
    return null;
  }
}

/** Human-readable explanation of why NDI is unavailable. */
function ndiUnavailableReason(): string {
  const msg = ndiLoadError ?? '';
  if (msg.includes('Processing.NDI') || msg.includes('.dll') || msg.includes('DLL')) {
    return 'NDI Runtime not installed — download NDI Tools from ndi.video/tools';
  }
  if (msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against a different')) {
    return 'grandiose needs to be recompiled for this Electron version — run: npm run setup-ndi';
  }
  if (msg.includes('Cannot find module') || msg.includes('grandiose')) {
    return 'grandiose not installed — run: npm run setup-ndi';
  }
  return msg ? `grandiose failed to load: ${msg}` : 'grandiose not installed — NDI SDK missing';
}

/**
 * Start NDI output.
 * Creates an invisible offscreen BrowserWindow that renders the live scripture
 * page. Every time the renderer paints a frame, the raw BGRA pixels are sent
 * straight to the NDI SDK sender — no polling, no capturePage overhead.
 */
function startNDI(sourceName: string): { ok: boolean; error?: string } {
  stopNDI(false);

  const grandiose = loadGrandiose();
  if (!grandiose) {
    return { ok: false, error: ndiUnavailableReason() };
  }

  // ── Create NDI sender first (fast — just registers the source name) ──
  try {
    ndiSender = grandiose.send({ name: sourceName, clockVideo: true, clockAudio: false });
  } catch (err: any) {
    ndiSender = null;
    return {
      ok: false,
      error: `NDI SDK error: ${err.message}. Make sure NDI Runtime is installed from ndi.video`,
    };
  }

  // ── Create offscreen renderer ──────────────────────────────────
  const offscreenWin = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,                    // completely hidden — no taskbar entry
    // transparent: true is intentionally omitted — on Windows, combining
    // transparent + offscreen + show:false prevents the compositor from
    // initialising and causes ERR_FAILED (-2) when loading the renderer URL.
    // Alpha transparency for NDI comes from the CSS/content (body { background: transparent })
    // and is carried in the BGRA pixel data via toBitmap() — the window chrome
    // transparency flag is not needed for correct NDI alpha output.
    backgroundColor: '#00000000',  // zero-alpha background so content transparency is preserved
    webPreferences: {
      offscreen: true,              // render into memory, fire paint events
      contextIsolation: false,      // allow executeJavaScript to reach window globals
      nodeIntegration: false,
      webSecurity: false,           // allow loading from localhost in offscreen context
    },
  });

  // Register window immediately so scripture data can be routed here
  liveWindows.set(NDI_WINDOW_ID, offscreenWin);

  // ── Wire paint events before loading URL so no frames are missed ──
  offscreenWin.webContents.setFrameRate(30);
  offscreenWin.webContents.on('paint', (_event, _dirty, image) => {
    if (!ndiSender) return;
    const size = image.getSize();
    if (size.width === 0 || size.height === 0) return;
    const frameData = image.toBitmap();   // raw BGRA buffer
    try {
      ndiSender.video({
        xres: size.width,
        yres: size.height,
        frameRateN: 30 * 1000,
        frameRateD: 1000,
        fourCC: grandiose.FOURCC_BGRA ?? 'BGRA',
        lineStrideBytes: size.width * 4,
        data: frameData,
        timecode: grandiose.SEND_TIMECODE_SYNTHESIZE ?? BigInt(0),
      });
    } catch { /* ignore individual frame errors */ }
  });

  offscreenWin.webContents.startPainting();

  offscreenWin.on('closed', () => {
    liveWindows.delete(NDI_WINDOW_ID);
  });

  // ── Load the live renderer page in the background (non-blocking) ──
  // NDI source is already visible in OBS; frames start flowing once page renders.
  const url = isDev
    ? `${DEV_SERVER_URL}/live.html`
    : `file://${path.join(__dirname, '../dist/live.html')}`;

  offscreenWin.loadURL(url).catch((err: any) => {
    console.error('[NDI] Renderer load failed:', err.message);
  });

  // ── Diagnostic: verify sender is visible to NDI find ──────────────
  // Runs 3 s after start so the sender has time to register on the network.
  // Check DevTools console for "[NDI] Visible sources" to confirm discovery.
  setTimeout(() => {
    try {
      const finder = grandiose.find({ showLocalSources: true });
      finder.sources(3000).then((sources: any[]) => {
        console.log(`[NDI] Visible sources (${sources.length}):`, sources.map((s: any) => s.name));
        if (sources.length === 0) {
          console.warn('[NDI] No sources found — check Windows Firewall and network profile (must be Private, not Public)');
        }
      }).catch(() => {});
    } catch { /* grandiose.find may not exist in all versions */ }
  }, 3000);

  return { ok: true };
}

function stopNDI(notify = true) {
  if (ndiSender) {
    try { ndiSender.destroy?.(); } catch { /* ignore */ }
    ndiSender = null;
  }

  const offscreenWin = liveWindows.get(NDI_WINDOW_ID);
  if (offscreenWin && !offscreenWin.isDestroyed()) {
    offscreenWin.destroy();
  }
  liveWindows.delete(NDI_WINDOW_ID);

  if (notify) {
    mainWindow?.webContents.send('ndi-status-changed', { status: 'stopped' });
  }
}

function getNDIStatus(): { status: string; reason?: string } {
  if (!loadGrandiose()) return { status: 'unavailable', reason: ndiUnavailableReason() };
  if (ndiSender) return { status: 'active' };
  return { status: 'stopped' };
}

// ── Window helpers ─────────────────────────────────────────────────

function createMainWindow() {
  const iconPath = isDev
    ? path.join(process.cwd(), 'public/favicon.ico')
    : path.join(__dirname, '../dist/favicon.ico');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopNDI(false);
    closeRealtimeWs();
    closeDeepgramWs();
    liveWindows.forEach(win => { try { win.close(); } catch { /* ignore */ } });
    liveWindows.clear();
  });
}

function createLiveWindow(windowId: string = 'main', displayId?: string) {
  if (liveWindows.has(windowId)) {
    liveWindows.get(windowId)!.focus();
    return;
  }

  let targetDisplay = screen.getPrimaryDisplay();
  if (displayId) {
    const displays = screen.getAllDisplays();
    const found = displays.find(d => d.id.toString() === displayId);
    if (found) targetDisplay = found;
  }

  const win = new BrowserWindow({
    x: targetDisplay.bounds.x + 50,
    y: targetDisplay.bounds.y + 50,
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: `ScriptureFlow Live Output${windowId !== 'main' ? ` (${windowId})` : ''}`,
    backgroundColor: '#000000',
  });

  if (isDev) {
    win.loadURL(`${DEV_SERVER_URL}/live.html`);
  } else {
    win.loadFile(path.join(__dirname, '../dist/live.html'));
  }

  liveWindows.set(windowId, win);

  win.on('closed', () => {
    liveWindows.delete(windowId);
    mainWindow?.webContents.send('live-window-status-changed', { windowId, status: 'closed' });
  });

  win.on('moved', () => {
    if (mainWindow && liveWindows.has(windowId)) {
      mainWindow.webContents.send('live-window-status-changed', { windowId, status: 'moved' });
      mainWindow.webContents.send('live-window-bounds-changed', { windowId, bounds: win.getBounds() });
    }
  });

  win.on('resized', () => {
    if (mainWindow && liveWindows.has(windowId)) {
      mainWindow.webContents.send('live-window-bounds-changed', { windowId, bounds: win.getBounds() });
    }
  });

  mainWindow?.webContents.send('live-window-status-changed', { windowId, status: 'open' });
  mainWindow?.webContents.send('live-window-bounds-changed', { windowId, bounds: win.getBounds() });
}

function notifyDisplaysChanged() {
  if (mainWindow) {
    const displays = screen.getAllDisplays().map(d => ({
      id: d.id.toString(),
      name: `Display ${d.id} (${d.bounds.width}x${d.bounds.height})`,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    }));
    mainWindow.webContents.send('displays-changed', displays);
  }
}

// ── Auto-updater ───────────────────────────────────────────────────

let updateDownloaded = false;     // true once a release is ready to install
let checkingManually  = false;    // true while the user triggered the check

function setupAutoUpdater() {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: ${info.version}`);
    if (checkingManually) {
      checkingManually = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `ScriptureFlow ${info.version} is available`,
        detail: 'Downloading in the background. You will be notified when it is ready to install.',
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] Already up to date.');
    if (checkingManually) {
      checkingManually = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'No Updates',
        message: 'You are up to date!',
        detail: `ScriptureFlow ${app.getVersion()} is the latest version.`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: ${info.version}`);
    updateDownloaded = true;
    // Update the menu so "Check for Updates" becomes "Restart to Install"
    buildAppMenu();
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `ScriptureFlow ${info.version} has been downloaded`,
      detail: 'Restart now to install the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    });
  });

  autoUpdater.on('error', (err) => {
    console.error(`[Updater] Error: ${err.message}`);
    if (checkingManually) {
      checkingManually = false;
      dialog.showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Could not check for updates.',
        detail: err.message,
        buttons: ['OK'],
      });
    }
  });

  // Silent check 5 s after startup, then every 4 hours
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1_000);
}

// ── Application menu ───────────────────────────────────────────────

function buildAppMenu() {
  const helpSubmenu: Electron.MenuItemConstructorOptions[] = updateDownloaded
    ? [
        {
          label: 'Restart to Install Update',
          click: () => autoUpdater.quitAndInstall(false, true),
        },
      ]
    : [
        {
          label: 'Check for Updates...',
          click: async () => {
            if (isDev) {
              dialog.showMessageBox({
                type: 'info',
                title: 'Development Mode',
                message: 'Update checking is disabled in development mode.',
                buttons: ['OK'],
              });
              return;
            }
            checkingManually = true;
            try {
              await autoUpdater.checkForUpdates();
            } catch (err: any) {
              checkingManually = false;
              dialog.showMessageBox({
                type: 'error',
                title: 'Update Check Failed',
                message: 'Could not reach the update server.',
                detail: err.message,
                buttons: ['OK'],
              });
            }
          },
        },
      ];

  helpSubmenu.push(
    { type: 'separator' },
    {
      label: 'About ScriptureFlow',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'About ScriptureFlow',
          message: 'ScriptureFlow',
          detail: `Version ${app.getVersion()}\n\nAI-powered worship display that listens to your preacher and puts scripture on screen automatically.`,
          buttons: ['OK'],
        });
      },
    },
  );

  const menu = Menu.buildFromTemplate([
    { role: 'fileMenu'   as const },
    { role: 'editMenu'   as const },
    { role: 'viewMenu'   as const },
    { role: 'windowMenu' as const },
    { label: 'Help', submenu: helpSubmenu },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── App lifecycle ──────────────────────────────────────────────────

app.whenReady().then(() => {
  // ── Grant microphone (and camera) access to all renderer windows ──────────
  // Without this handler Electron 36+ silently denies getUserMedia, which breaks
  // the Browser Speech Recognition and Gemini Live Audio transcription providers.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'microphone', 'speech'].includes(permission);
    callback(allowed);
  });

  // ── Register WebSocket bridge IPC handlers BEFORE opening any window ─────
  // Guarantees channels are ready before any preload/renderer can invoke them.
  registerRealtimeHandlers();
  registerDeepgramHandlers();
  buildAppMenu();
  setupAutoUpdater();

  createMainWindow();
  // Live window is opened on demand when the user clicks "Open Window" in Settings.
  // Do NOT auto-open here — it should only appear after the user explicitly requests it.

  screen.on('display-added', notifyDisplaysChanged);
  screen.on('display-removed', notifyDisplaysChanged);
  screen.on('display-metrics-changed', notifyDisplaysChanged);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopNDI(false);
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── IPC: Live window ───────────────────────────────────────────────

ipcMain.on('send-to-live', (event, { windowId = 'main', data }: { windowId?: string; data: any }) => {
  const win = liveWindows.get(windowId);
  if (!win || win.isDestroyed()) return;
  if (windowId === NDI_WINDOW_ID) {
    // NDI offscreen window has no preload — push data via executeJavaScript
    win.webContents.executeJavaScript(
      `window.__ndiUpdate && window.__ndiUpdate(${JSON.stringify(data)})`
    ).catch(() => {});
  } else {
    win.webContents.send('update-live', data);
  }
});

ipcMain.on('send-theme-to-live', (event, theme, layout) => {
  liveWindows.forEach(win => win.webContents.send('update-theme', theme, layout));
});

ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays();
  return displays.map(d => ({
    id: d.id.toString(),
    name: `Display ${d.id} (${d.bounds.width}x${d.bounds.height})`,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }));
});

ipcMain.on('open-live-window', (event, { windowId = 'main', displayId }: { windowId?: string; displayId?: string }) => {
  createLiveWindow(windowId, displayId);
});

ipcMain.on('close-live-window', (event, windowId: string = 'main') => {
  liveWindows.get(windowId)?.close();
});

ipcMain.on('move-live-window', (event, { windowId = 'main', displayId }: { windowId?: string; displayId: string }) => {
  const win = liveWindows.get(windowId);
  if (!win) {
    createLiveWindow(windowId, displayId);
    return;
  }

  const displays = screen.getAllDisplays();
  const targetDisplay = displays.find(d => d.id.toString() === displayId);
  if (targetDisplay) {
    win.setBounds({
      x: targetDisplay.bounds.x + 50,
      y: targetDisplay.bounds.y + 50,
      width: 1280,
      height: 720,
    });
    mainWindow?.webContents.send('live-window-status-changed', { windowId, status: 'moved' });
  }
});

// ── IPC: NDI ───────────────────────────────────────────────────────

ipcMain.handle('ndi-start', (_event, { sourceName }: { sourceName: string }) => {
  const result = startNDI(sourceName);
  mainWindow?.webContents.send('ndi-status-changed', {
    status: result.ok ? 'active' : 'error',
    sourceName: result.ok ? sourceName : undefined,
    error: result.error,
  });
  return result;
});

ipcMain.on('ndi-stop', () => {
  stopNDI(true);
});

ipcMain.on('open-external', (_event, url: string) => {
  // Only allow https:// links to prevent abuse
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

// ── IPC: OpenAI Realtime WebSocket bridge ──────────────────────────────────────
// Handlers are registered inside registerRealtimeHandlers() which is called from
// app.whenReady() BEFORE createMainWindow().  This guarantees registration is
// complete before any preload/renderer can invoke the channel.
// ipcMain.removeHandler() guards prevent "already registered" throws on any
// accidental second call (e.g. hot-reload scenarios in dev).

function registerRealtimeHandlers(): void {
  console.log('[Main] Registering Realtime IPC handlers…');

  // Guard: remove any stale handler from a previous registration attempt.
  ipcMain.removeHandler('realtime-connect');

  ipcMain.handle('realtime-connect', (event, { url, apiKey }: { url: string; apiKey: string }) => {
    console.log('[Main] realtime-connect handler invoked');
    closeRealtimeWs();

    // Lazy-load ws — safe even if the package is temporarily missing
    const { WS, error: wsLoadError } = loadWsClass();
    if (!WS) {
      return { ok: false, error: wsLoadError };
    }

    const hasKey = typeof apiKey === 'string' && apiKey.length > 0;
    console.log(`[RealtimeWS] key present: ${hasKey}${hasKey ? `, prefix: ${apiKey.slice(0, 7)}…` : ''}`);

    if (!hasKey) {
      console.error('[RealtimeWS] Aborted — no API key provided.');
      return { ok: false, error: 'No OpenAI API key configured. Enter your key in Settings → Audio & Transcription.' };
    }

    realtimeWsOwner = event.sender;

    try {
      realtimeWs = new WS(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });
      console.log('[RealtimeWS] WebSocket created, waiting for open…');
    } catch (err: any) {
      console.error(`[RealtimeWS] Failed to create WebSocket: ${err.message}`);
      realtimeWsOwner = null;
      return { ok: false, error: err.message };
    }

    realtimeWs.on('open', () => {
      console.log('[RealtimeWS] Connection opened');
      if (realtimeWsOwner && !realtimeWsOwner.isDestroyed()) {
        realtimeWsOwner.send('realtime-open');
      }
    });

    realtimeWs.on('message', (data: any) => {
      if (realtimeWsOwner && !realtimeWsOwner.isDestroyed()) {
        realtimeWsOwner.send('realtime-message', data.toString());
      }
    });

    realtimeWs.on('close', (code: number, reason: Buffer) => {
      console.log(`[RealtimeWS] Closed — code: ${code}, reason: ${reason.toString() || '(none)'}`);
      realtimeWs = null;
      if (realtimeWsOwner && !realtimeWsOwner.isDestroyed()) {
        realtimeWsOwner.send('realtime-close', code, reason.toString());
      }
      realtimeWsOwner = null;
    });

    realtimeWs.on('error', (err: Error) => {
      console.error(`[RealtimeWS] Socket error: ${err.message}`);
      if (realtimeWsOwner && !realtimeWsOwner.isDestroyed()) {
        realtimeWsOwner.send('realtime-error', err.message);
      }
    });

    return { ok: true };
  });

  // fire-and-forget: no removeHandler needed for ipcMain.on (no duplicate-throw risk)
  ipcMain.on('realtime-send', (_event, data: string) => {
    if (realtimeWs && realtimeWs.readyState === 1 /* OPEN */) {
      try { realtimeWs.send(data); } catch (err: any) {
        console.error(`[RealtimeWS] Send failed: ${err.message}`);
      }
    }
  });

  ipcMain.on('realtime-disconnect', () => {
    console.log('[RealtimeWS] Disconnect requested by renderer');
    closeRealtimeWs();
  });

  console.log('[Main] Realtime IPC handlers registered ✓');
}

ipcMain.handle('ndi-get-status', () => {
  return getNDIStatus();   // already returns { status, reason? }
});

// ── IPC: Deepgram WebSocket bridge ─────────────────────────────────────────────
// Deepgram streaming API requires  Authorization: Token <key>  — a custom header
// that the renderer-side browser WebSocket API cannot set.  The main process owns
// the socket (using the `ws` package) and forwards binary audio frames and JSON
// control messages in both directions via IPC.

function registerDeepgramHandlers(): void {
  console.log('[Main] Registering Deepgram IPC handlers…');

  ipcMain.removeHandler('deepgram-connect');

  ipcMain.handle('deepgram-connect', (event, { url, apiKey }: { url: string; apiKey: string }) => {
    closeDeepgramWs();

    const { WS, error: wsLoadError } = loadWsClass();
    if (!WS) return { ok: false, error: wsLoadError };

    if (!apiKey) {
      return { ok: false, error: 'No Deepgram API key configured. Enter your key in Settings → Audio & Transcription.' };
    }

    deepgramWsOwner = event.sender;

    try {
      deepgramWs = new WS(url, {
        headers: { 'Authorization': `Token ${apiKey}` },
      });
    } catch (err: any) {
      deepgramWsOwner = null;
      return { ok: false, error: err.message };
    }

    deepgramWs.on('open', () => {
      console.log('[DeepgramWS] Connection opened');
      if (deepgramWsOwner && !deepgramWsOwner.isDestroyed()) {
        deepgramWsOwner.send('deepgram-open');
      }
    });

    deepgramWs.on('message', (data: Buffer) => {
      if (deepgramWsOwner && !deepgramWsOwner.isDestroyed()) {
        deepgramWsOwner.send('deepgram-message', data.toString());
      }
    });

    deepgramWs.on('close', (code: number, reason: Buffer) => {
      console.log(`[DeepgramWS] Closed — code: ${code}, reason: ${reason.toString() || '(none)'}`);
      deepgramWs = null;
      if (deepgramWsOwner && !deepgramWsOwner.isDestroyed()) {
        deepgramWsOwner.send('deepgram-close', code, reason.toString());
      }
      deepgramWsOwner = null;
    });

    deepgramWs.on('error', (err: Error) => {
      console.error(`[DeepgramWS] Socket error: ${err.message}`);
      if (deepgramWsOwner && !deepgramWsOwner.isDestroyed()) {
        deepgramWsOwner.send('deepgram-error', err.message);
      }
    });

    return { ok: true };
  });

  // Send a raw binary audio frame (ArrayBuffer from renderer → Buffer in Node → binary WS frame)
  ipcMain.on('deepgram-send-audio', (_event, data: Buffer) => {
    if (deepgramWs && deepgramWs.readyState === 1 /* OPEN */) {
      try { deepgramWs.send(data); } catch (err: any) {
        console.error(`[DeepgramWS] Audio send failed: ${err.message}`);
      }
    }
  });

  // Send a JSON control message (CloseStream, KeepAlive)
  ipcMain.on('deepgram-send-json', (_event, data: string) => {
    if (deepgramWs && deepgramWs.readyState === 1 /* OPEN */) {
      try { deepgramWs.send(data); } catch (err: any) {
        console.error(`[DeepgramWS] JSON send failed: ${err.message}`);
      }
    }
  });

  ipcMain.on('deepgram-disconnect', () => {
    console.log('[DeepgramWS] Disconnect requested by renderer');
    closeDeepgramWs();
  });

  console.log('[Main] Deepgram IPC handlers registered ✓');
}
