import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Send payload to a specific live window (or 'main' by default)
  sendToLive: (windowId: string, data: any) => ipcRenderer.send('send-to-live', { windowId, data }),
  onUpdateLive: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('update-live');
    ipcRenderer.on('update-live', (_event, value) => callback(value));
  },

  sendThemeToLive: (theme: string, layout: string) => ipcRenderer.send('send-theme-to-live', theme, layout),
  onUpdateTheme: (callback: (theme: string, layout: string) => void) => {
    ipcRenderer.removeAllListeners('update-theme');
    ipcRenderer.on('update-theme', (_event, theme, layout) => callback(theme, layout));
  },

  getDisplays: () => ipcRenderer.invoke('get-displays'),

  // Multi-window management: all calls include a windowId
  openLiveWindow: (windowId: string, displayId?: string) =>
    ipcRenderer.send('open-live-window', { windowId, displayId }),
  closeLiveWindow: (windowId: string) =>
    ipcRenderer.send('close-live-window', windowId),
  moveLiveWindow: (windowId: string, displayId: string) =>
    ipcRenderer.send('move-live-window', { windowId, displayId }),

  // Events now carry { windowId, status } / { windowId, bounds }
  onLiveWindowStatusChanged: (callback: (payload: { windowId: string; status: string }) => void) => {
    ipcRenderer.removeAllListeners('live-window-status-changed');
    ipcRenderer.on('live-window-status-changed', (_event, payload) => callback(payload));
  },
  onLiveWindowBoundsChanged: (callback: (payload: { windowId: string; bounds: any }) => void) => {
    ipcRenderer.removeAllListeners('live-window-bounds-changed');
    ipcRenderer.on('live-window-bounds-changed', (_event, payload) => callback(payload));
  },

  onDisplaysChanged: (callback: (displays: any[]) => void) => {
    ipcRenderer.removeAllListeners('displays-changed');
    ipcRenderer.on('displays-changed', (_event, displays) => callback(displays));
  },

  // ── NDI ─────────────────────────────────────────────────────────
  /** Start NDI output. Renders into an offscreen window and sends paint frames as NDI stream. */
  ndiStart: (sourceName: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ndi-start', { sourceName }),

  /** Stop NDI output. */
  ndiStop: () => ipcRenderer.send('ndi-stop'),

  /** Get current NDI status from main process. */
  ndiGetStatus: (): Promise<{ status: string }> =>
    ipcRenderer.invoke('ndi-get-status'),

  /** Subscribe to NDI status changes pushed from main. */
  onNDIStatusChanged: (callback: (payload: { status: string; sourceName?: string; error?: string }) => void) => {
    ipcRenderer.removeAllListeners('ndi-status-changed');
    ipcRenderer.on('ndi-status-changed', (_event, payload) => callback(payload));
  },

  /** Open a URL in the system's default browser (safe external link handler) */
  openExternal: (url: string) => ipcRenderer.send('open-external', url),

  // ── Auto-updater ─────────────────────────────────────────────────────────────
  /** Fired when a new version is available and the download is starting. */
  onUpdateAvailable: (callback: (version: string) => void): void => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.on('update-available', (_event, version) => callback(version));
  },

  /** Fired periodically during download with a 0-100 progress value. */
  onUpdateDownloadProgress: (callback: (percent: number) => void): void => {
    ipcRenderer.removeAllListeners('update-download-progress');
    ipcRenderer.on('update-download-progress', (_event, percent) => callback(percent));
  },

  /** Fired when the update has been fully downloaded and is ready to install. */
  onUpdateDownloaded: (callback: (version: string) => void): void => {
    ipcRenderer.removeAllListeners('update-downloaded');
    ipcRenderer.on('update-downloaded', (_event, version) => callback(version));
  },

  /** Tell the main process to quit and install the downloaded update now. */
  installUpdate: (): void => ipcRenderer.send('install-update'),

  // ── Realtime WebSocket bridge ──────────────────────────────────────────────
  // The main process owns the authenticated WS; the renderer tunnels audio/events
  // through IPC so the API key never appears in renderer network traffic.

  /** Ask main to open an authenticated WebSocket. Resolves once the socket is created. */
  realtimeConnect: (url: string, apiKey: string): Promise<{ ok: boolean; error?: string }> => {
    console.log('[Preload] realtimeConnect invoked → ipcRenderer.invoke(\'realtime-connect\')');
    return ipcRenderer.invoke('realtime-connect', { url, apiKey });
  },

  /** Send a JSON-string message (audio chunk or command) to the open socket. */
  realtimeSend: (data: string): void => ipcRenderer.send('realtime-send', data),

  /** Close the socket in main process. */
  realtimeDisconnect: (): void => ipcRenderer.send('realtime-disconnect'),

  /** Fired when the socket opens (before session.created arrives). */
  onRealtimeOpen: (callback: () => void): void => {
    ipcRenderer.removeAllListeners('realtime-open');
    ipcRenderer.on('realtime-open', () => callback());
  },

  /** Fired for every message pushed from the OpenAI server. */
  onRealtimeMessage: (callback: (data: string) => void): void => {
    ipcRenderer.removeAllListeners('realtime-message');
    ipcRenderer.on('realtime-message', (_event, data) => callback(data));
  },

  /** Fired when the socket closes. code 3000/4001 = auth error. */
  onRealtimeClose: (callback: (code: number, reason: string) => void): void => {
    ipcRenderer.removeAllListeners('realtime-close');
    ipcRenderer.on('realtime-close', (_event, code, reason) => callback(code, reason));
  },

  /** Fired on a socket-level network error (distinct from OpenAI application errors). */
  onRealtimeError: (callback: (message: string) => void): void => {
    ipcRenderer.removeAllListeners('realtime-error');
    ipcRenderer.on('realtime-error', (_event, message) => callback(message));
  },

  // ── Deepgram WebSocket bridge ──────────────────────────────────────────────
  // The main process owns the authenticated WS; the renderer tunnels binary audio
  // frames and JSON control messages through IPC so the API key never appears in
  // renderer network traffic (Authorization: Token header set in Node.js ws).

  /** Ask main to open an authenticated Deepgram WebSocket. */
  deepgramConnect: (url: string, apiKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('deepgram-connect', { url, apiKey }),

  /** Send a binary PCM16 audio frame to the open socket. */
  deepgramSendAudio: (data: ArrayBuffer): void => ipcRenderer.send('deepgram-send-audio', data),

  /** Send a JSON control message (CloseStream, KeepAlive) to the open socket. */
  deepgramSendJson: (data: string): void => ipcRenderer.send('deepgram-send-json', data),

  /** Close the Deepgram socket in the main process. */
  deepgramDisconnect: (): void => ipcRenderer.send('deepgram-disconnect'),

  /** Fired when the socket opens. */
  onDeepgramOpen: (callback: () => void): void => {
    ipcRenderer.removeAllListeners('deepgram-open');
    ipcRenderer.on('deepgram-open', () => callback());
  },

  /** Fired for every JSON message pushed from the Deepgram server. */
  onDeepgramMessage: (callback: (data: string) => void): void => {
    ipcRenderer.removeAllListeners('deepgram-message');
    ipcRenderer.on('deepgram-message', (_event, data) => callback(data));
  },

  /** Fired when the socket closes. */
  onDeepgramClose: (callback: (code: number, reason: string) => void): void => {
    ipcRenderer.removeAllListeners('deepgram-close');
    ipcRenderer.on('deepgram-close', (_event, code, reason) => callback(code, reason));
  },

  /** Fired on a socket-level network error. */
  onDeepgramError: (callback: (message: string) => void): void => {
    ipcRenderer.removeAllListeners('deepgram-error');
    ipcRenderer.on('deepgram-error', (_event, message) => callback(message));
  },
});
