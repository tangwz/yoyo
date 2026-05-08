import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifestVersion: 3,
  alias: {
    "@/messaging": "src/messaging",
    "@/translation": "src/translation",
    "@/ui": "src/ui",
    "@/utils": "src/utils",
  },
  manifest: {
    name: "悠悠阅读助手",
    description: "A privacy-conscious LLM reading and translation assistant.",
    version: "0.1.0",
    permissions: ["storage", "contextMenus", "notifications", "activeTab", "scripting"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "悠悠阅读助手",
    },
  },
});
