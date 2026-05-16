const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codiff', {
  getDiffSectionContent: (request) => ipcRenderer.invoke('codiff:getDiffSectionContent', request),
  getPreferences: () => ipcRenderer.invoke('codiff:getPreferences'),
  getRepositoryHistory: (limit) => ipcRenderer.invoke('codiff:getRepositoryHistory', limit),
  getRepositoryState: (source) => ipcRenderer.invoke('codiff:getRepositoryState', source),
  isDifftAvailable: () => ipcRenderer.invoke('codiff:isDifftAvailable'),
  onPreferencesChanged: (callback) => {
    const listener = (_event, preferences) => callback(preferences);
    ipcRenderer.on('codiff:preferencesChanged', listener);
    return () => ipcRenderer.removeListener('codiff:preferencesChanged', listener);
  },
  onRepositoryChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:repositoryChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryChanged', listener);
  },
  refreshDifftAvailability: () => ipcRenderer.invoke('codiff:refreshDifftAvailability'),
  runDifft: (request) => ipcRenderer.invoke('codiff:runDifft', request),
  showInFolder: (path) => ipcRenderer.invoke('codiff:showInFolder', path),
});
