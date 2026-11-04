'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  init: () => ipcRenderer.invoke('pet:init'),
  onSet: (cb) => ipcRenderer.on('pet:set', (_e, payload) => cb(payload)),
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, p) => cb(p)),
  onWalk: (cb) => ipcRenderer.on('pet:walk', (_e, p) => cb(p)),
  onForce: (cb) => ipcRenderer.on('pet:force', (_e, p) => cb(p)),
  onConfig: (cb) => ipcRenderer.on('pet:config', (_e, p) => cb(p)),
  onFeed: (cb) => ipcRenderer.on('pet:feed', (_e, p) => cb(p)),
  wander: () => ipcRenderer.invoke('pet:wander'),
  idleSeconds: () => ipcRenderer.invoke('app:idle'),
  log: (msg) => ipcRenderer.send('app:log', msg),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  menu: () => ipcRenderer.send('pet:menu'),
  openPicker: () => ipcRenderer.send('pet:open-picker'),
});
