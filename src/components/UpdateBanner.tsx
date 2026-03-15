import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string };

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;  // running in browser / dev without Electron

    api.onUpdateAvailable?.((version) => {
      setState({ phase: 'available', version });
      setDismissed(false);
    });

    api.onUpdateDownloadProgress?.((percent) => {
      setState(prev =>
        prev.phase === 'available' || prev.phase === 'downloading'
          ? { phase: 'downloading', version: (prev as any).version, percent }
          : prev,
      );
    });

    api.onUpdateDownloaded?.((version) => {
      setState({ phase: 'ready', version });
      setDismissed(false);
    });
  }, []);

  if (state.phase === 'idle' || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-indigo-600 text-white text-sm shrink-0">
      {state.phase === 'available' && (
        <>
          <Download size={15} className="shrink-0" />
          <span className="flex-1">
            ScriptureFlow <strong>{state.version}</strong> is available — downloading in the background…
          </span>
        </>
      )}

      {state.phase === 'downloading' && (
        <>
          <Download size={15} className="shrink-0 animate-bounce" />
          <span className="flex-1">
            Downloading update <strong>{state.version}</strong>…
          </span>
          {/* Progress bar */}
          <div className="w-32 h-1.5 bg-indigo-400 rounded-full overflow-hidden">
            <div
              className="h-full bg-white rounded-full transition-all duration-300"
              style={{ width: `${state.percent}%` }}
            />
          </div>
          <span className="w-10 text-right text-xs text-indigo-200">{state.percent}%</span>
        </>
      )}

      {state.phase === 'ready' && (
        <>
          <RefreshCw size={15} className="shrink-0" />
          <span className="flex-1">
            ScriptureFlow <strong>{state.version}</strong> is ready — restart to install.
          </span>
          <button
            onClick={() => window.electronAPI?.installUpdate?.()}
            className="px-3 py-0.5 bg-white text-indigo-700 font-medium rounded hover:bg-indigo-50 transition-colors text-xs"
          >
            Restart now
          </button>
        </>
      )}

      {/* Dismiss only in non-critical states */}
      {state.phase !== 'downloading' && (
        <button
          onClick={() => setDismissed(true)}
          className="ml-1 text-indigo-200 hover:text-white transition-colors"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
