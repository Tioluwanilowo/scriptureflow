export {};

declare global {
  interface Window {
    electronAPI?: {
      sendToLive: (windowId: string, data: any) => void;
      onUpdateLive: (callback: (data: any) => void) => void;
      sendThemeToLive: (theme: string, layout: string) => void;
      onUpdateTheme: (callback: (theme: string, layout: string) => void) => void;
      getDisplays: () => Promise<any[]>;
      openLiveWindow: (windowId: string, displayId?: string) => void;
      closeLiveWindow: (windowId: string) => void;
      moveLiveWindow: (windowId: string, displayId: string) => void;
      onLiveWindowStatusChanged: (callback: (payload: { windowId: string; status: string }) => void) => void;
      onLiveWindowBoundsChanged: (callback: (payload: { windowId: string; bounds: any }) => void) => void;
      onDisplaysChanged: (callback: (displays: any[]) => void) => void;

      // NDI — offscreen renderer approach; no windowId needed
      ndiStart: (sourceName: string) => Promise<{ ok: boolean; error?: string }>;
      ndiStop: () => void;
      ndiGetStatus: () => Promise<{ status: string }>;
      onNDIStatusChanged: (callback: (payload: { status: string; sourceName?: string; error?: string }) => void) => void;

      /** Open a URL in the system default browser */
      openExternal?: (url: string) => void;

      // Auto-updater
      onUpdateAvailable?: (callback: (version: string) => void) => void;
      onUpdateDownloadProgress?: (callback: (percent: number) => void) => void;
      onUpdateDownloaded?: (callback: (version: string) => void) => void;
      installUpdate?: () => void;

      // Realtime WebSocket bridge
      realtimeConnect: (url: string, apiKey: string) => Promise<{ ok: boolean; error?: string }>;
      realtimeSend: (data: string) => void;
      realtimeDisconnect: () => void;
      onRealtimeOpen: (callback: () => void) => void;
      onRealtimeMessage: (callback: (data: string) => void) => void;
      onRealtimeClose: (callback: (code: number, reason: string) => void) => void;
      onRealtimeError: (callback: (message: string) => void) => void;

      // Deepgram WebSocket bridge
      deepgramConnect: (url: string, apiKey: string) => Promise<{ ok: boolean; error?: string }>;
      deepgramSendAudio: (data: ArrayBuffer) => void;
      deepgramSendJson: (data: string) => void;
      deepgramDisconnect: () => void;
      onDeepgramOpen: (callback: () => void) => void;
      onDeepgramMessage: (callback: (data: string) => void) => void;
      onDeepgramClose: (callback: (code: number, reason: string) => void) => void;
      onDeepgramError: (callback: (message: string) => void) => void;
    };
  }
}
