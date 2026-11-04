'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerBridge', {
  init: () => ipcRenderer.invoke('picker:init'),
  choose: (id) => ipcRenderer.invoke('picker:choose', id),
  fav: (id, on) => ipcRenderer.invoke('picker:fav', id, on),
});
