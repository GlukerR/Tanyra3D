const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tanyraDesktop', {
  readNeighbors: (file, names) => {
    let modelPath = '';
    try { modelPath = webUtils.getPathForFile(file); } catch {  }
    if (!modelPath) return Promise.resolve([]);
    return ipcRenderer.invoke('neighbors:read', modelPath, names);
  },
});
