import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ayana', Object.freeze({
  send: (command: Record<string, unknown>) => ipcRenderer.invoke('ayana:command', command),
  onEvent: (callback: (event: Record<string, unknown>) => void) => {
    const listener = (_event: unknown, value: Record<string, unknown>) => callback(value);
    ipcRenderer.on('ayana:event', listener);
    return () => ipcRenderer.removeListener('ayana:event', listener);
  },
  playback: (receipt: Record<string, unknown>) => ipcRenderer.send('ayana:playback', receipt),
  summon: () => ipcRenderer.invoke('ayana:summon'),
  hide: () => ipcRenderer.invoke('ayana:hide'),
  beginTalk: () => ipcRenderer.invoke('ayana:talk-start'),
  endTalk: (id: string, cancelled?: boolean) => ipcRenderer.invoke('ayana:talk-end', id, cancelled),
  setCompanionInteractive: (interactive: boolean) => ipcRenderer.send('ayana:companion-interactive', interactive),
  moveCompanion: (dx: number, dy: number) => ipcRenderer.send('ayana:companion-move', dx, dy),
  beginCompanionDrag: () => ipcRenderer.send('ayana:companion-drag-start'),
  endCompanionDrag: () => ipcRenderer.send('ayana:companion-drag-end'),
  openDesign: () => ipcRenderer.invoke('ayana:design-open'),
  closeDesign: () => ipcRenderer.invoke('ayana:design-close'),
  previewDesign: (value: Record<string, unknown>) => ipcRenderer.send('ayana:design-preview', value),
  revertDesignPreview: () => ipcRenderer.invoke('ayana:design-revert-preview'),
  openCompanionMenu: () => ipcRenderer.invoke('ayana:companion-menu'),
  chooseNoteBackground: () => ipcRenderer.invoke('ayana:note-background'),
  openSettings: (tab?: string) => ipcRenderer.invoke('ayana:settings', tab),
  openWelcome: () => ipcRenderer.invoke('ayana:welcome-open'),
  welcomeTarget: () => ipcRenderer.invoke('ayana:welcome-target'),
  finishWelcome: (configure?: boolean) => ipcRenderer.invoke('ayana:welcome-finish', configure),
  closeWelcome: () => ipcRenderer.invoke('ayana:welcome-close'),
  welcomeShortcutCapture: (capturing: boolean) => ipcRenderer.invoke('ayana:welcome-shortcut-capture', capturing),
  welcomeShortcutCheck: (field: string, value: string) => ipcRenderer.invoke('ayana:welcome-shortcut-check', field, value),
  hideSettings: () => ipcRenderer.invoke('ayana:hide-settings'),
  restart: () => ipcRenderer.invoke('ayana:restart'),
  restartApp: () => ipcRenderer.invoke('ayana:app-restart'),
  voicePack: Object.freeze({
    get: () => ipcRenderer.invoke('ayana:voice-pack'),
    start: () => ipcRenderer.invoke('ayana:voice-pack-start'),
    cancel: () => ipcRenderer.invoke('ayana:voice-pack-cancel'),
    importLocal: () => ipcRenderer.invoke('ayana:voice-pack-import'),
  }),
  getState: () => ipcRenderer.invoke('ayana:state'),
}));
