const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('continuum', {
  call: (method, payload) => ipcRenderer.invoke('continuum:call', method, payload),
  onSnapshot: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('continuum:snapshot', listener);
    return () => ipcRenderer.removeListener('continuum:snapshot', listener);
  },
  onProgress: callback => {
    const listener = (_event, stage) => callback(stage);
    ipcRenderer.on('continuum:progress', listener);
    return () => ipcRenderer.removeListener('continuum:progress', listener);
  },
});
