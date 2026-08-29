// Context bridge: the ONLY surface the renderer gets. No Node, no shell.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  redact: (payload) => ipcRenderer.invoke('redact', payload),
  openFiles: () => ipcRenderer.invoke('open-files'),
  saveText: (text) => ipcRenderer.invoke('save-text', text),
  savePdf: (text) => ipcRenderer.invoke('save-pdf', text),
  saveLayoutPdf: (pages) => ipcRenderer.invoke('save-layout-pdf', pages),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
});
