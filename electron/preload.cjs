const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lunchSync', {
  getState: () => ipcRenderer.invoke('sync:getState'),
  startHost: snapshot => ipcRenderer.invoke('sync:startHost', snapshot),
  joinHost: input => ipcRenderer.invoke('sync:joinHost', input),
  mutate: operation => ipcRenderer.invoke('sync:mutate', operation),
  onStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('sync:status', listener);
    return () => ipcRenderer.removeListener('sync:status', listener);
  },
  onSnapshot: callback => {
    const listener = (_event, envelope) => callback(envelope);
    ipcRenderer.on('sync:snapshot', listener);
    return () => ipcRenderer.removeListener('sync:snapshot', listener);
  }
});
