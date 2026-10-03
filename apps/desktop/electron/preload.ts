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
  chooseRepository: () => ipcRenderer.invoke('ayana:choose-repository'),
  restart: () => ipcRenderer.invoke('ayana:restart'),
  getState: () => ipcRenderer.invoke('ayana:state'),
}));
