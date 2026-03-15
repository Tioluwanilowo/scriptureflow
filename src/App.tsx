import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import PreviewPanel from './components/PreviewPanel';
import ActivityPanel from './components/ActivityPanel';
import SuggestionsColumn from './components/SuggestionsColumn';
import Controls from './components/Controls';
import DevSimulator from './components/DevSimulator';
import ThemeDesigner from './components/ThemeDesigner';
import HotkeyManager from './components/HotkeyManager';
import LiveOutputManager from './components/LiveOutputManager';
import LiveStatusPanel from './components/LiveStatusPanel';
import UpdateBanner from './components/UpdateBanner';
import { useStore } from './store/useStore';
import { loadDefaultBibles } from './lib/bibleEngine';
import { bibleLibrary } from './lib/bible/BibleLibraryManager';

export default function App() {
  const showSimulator = useStore(state => state.showSimulator);
  const showThemeDesigner = useStore(state => state.showThemeDesigner);
  const toggleThemeDesigner = useStore(state => state.toggleThemeDesigner);
  const setAvailableVersions = useStore(state => state.setAvailableVersions);
  const [biblesLoaded, setBiblesLoaded] = useState(false);

  useEffect(() => {
    loadDefaultBibles().then(() => {
      const versions = bibleLibrary.getAvailableVersions();
      if (versions.length > 0) setAvailableVersions(versions);
      setBiblesLoaded(true);
    });
  }, []);

  if (!biblesLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100 font-sans">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-zinc-400">Loading Bible Data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans">
      <UpdateBanner />
      <HotkeyManager />
      <LiveOutputManager />
      <LiveStatusPanel />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <PreviewPanel />
        {showSimulator && <DevSimulator />}
        {showThemeDesigner && <ThemeDesigner onClose={toggleThemeDesigner} />}
        <SuggestionsColumn />
        <ActivityPanel />
      </div>
      <Controls />
    </div>
  );
}
