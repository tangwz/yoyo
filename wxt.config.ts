import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifestVersion: 3,
  srcDir: "src",
  entrypointsDir: "../entrypoints",
  outDir: "build",
  manifest: {
    name: "悠悠阅读助手",
    description: "A privacy-conscious LLM reading and translation assistant.",
    version: "0.5.2",
    permissions: ["storage", "contextMenus", "notifications", "offscreen"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "悠悠阅读助手",
    },
  },
});
