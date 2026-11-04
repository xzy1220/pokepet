'use strict';
// 关于 / 支持 窗口用的最小桥：只读，不暴露任何文件系统能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('info', {
  get: () => ipcRenderer.invoke('info:get'),
  openUrl: (url) => ipcRenderer.invoke('info:open-url', url),
  close: () => ipcRenderer.invoke('info:close'),
});
