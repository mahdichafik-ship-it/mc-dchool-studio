"use strict";
const electron = require("electron");
const api = {
  invoke: (channel, args) => electron.ipcRenderer.invoke(channel, args),
  on: (channel, listener) => {
    const wrappedListener = (_event, ...args) => listener(...args);
    electron.ipcRenderer.on(channel, wrappedListener);
    return () => electron.ipcRenderer.off(channel, wrappedListener);
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
