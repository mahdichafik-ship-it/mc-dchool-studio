"use strict";
const electron = require("electron");
const node_crypto = require("node:crypto");
const dropCapabilityToken = node_crypto.randomBytes(32).toString("base64url");
electron.ipcRenderer.send("watcher:registerDropCapability", dropCapabilityToken);
const api = {
  invoke: (channel, args) => electron.ipcRenderer.invoke(channel, args),
  ingestDroppedFiles: async (projectId, studentId, files) => {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("No dropped files were provided");
    }
    const filePaths = files.map((file, index) => {
      let filePath = "";
      try {
        filePath = electron.webUtils.getPathForFile(file);
      } catch {
        filePath = "";
      }
      if (!filePath.trim()) {
        throw new Error(`Dropped file ${index + 1} has no local filesystem path`);
      }
      return filePath;
    });
    return electron.ipcRenderer.invoke("watcher:ingestDroppedFiles", {
      capabilityToken: dropCapabilityToken,
      projectId,
      studentId,
      filePaths
    });
  },
  on: (channel, listener) => {
    const wrappedListener = (_event, ...args) => listener(...args);
    electron.ipcRenderer.on(channel, wrappedListener);
    return () => electron.ipcRenderer.off(channel, wrappedListener);
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
