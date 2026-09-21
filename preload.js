const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenflow', {
  isElectron: true,
  setShareSource: (id) => ipcRenderer.invoke('set-share-source', id),
  getScreenAccessStatus: () => ipcRenderer.invoke('get-screen-access-status'),
  requestScreenAccess: () => ipcRenderer.invoke('request-screen-access'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  startLanServer: () => ipcRenderer.invoke('lan-server-start'),
  stopLanServer: () => ipcRenderer.invoke('lan-server-stop'),
  startDiscovery: (code) => ipcRenderer.invoke('discovery-start', code),
  stopDiscovery: () => ipcRenderer.invoke('discovery-stop'),
  discoverPeer: (code) => ipcRenderer.invoke('discover-peer', code),
  getLanAddresses: () => ipcRenderer.invoke('get-lan-addresses'),
});
