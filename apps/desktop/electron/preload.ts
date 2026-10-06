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
  setCompanionInteractive: (interactive: boolean) => ipcRenderer.send('ayana:companion-interactive', interactive),
  moveCompanion: (dx: number, dy: number) => ipcRenderer.send('ayana:companion-move', dx, dy),
  openCompanionMenu: () => ipcRenderer.invoke('ayana:companion-menu'),
  chooseNoteBackground: () => ipcRenderer.invoke('ayana:note-background'),
  openSettings: (tab?: string) => ipcRenderer.invoke('ayana:settings', tab),
  hideSettings: () => ipcRenderer.invoke('ayana:hide-settings'),
  chooseRepository: () => ipcRenderer.invoke('ayana:choose-repository'),
  chooseDirectory: () => ipcRenderer.invoke('ayana:choose-directory'),
  restart: () => ipcRenderer.invoke('ayana:restart'),
  getState: () => ipcRenderer.invoke('ayana:state'),
}));
