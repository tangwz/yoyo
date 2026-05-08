import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  alias: {
    "@/ui": "src/ui",
  },
  manifest: {
    name: "悠悠阅读助手",
    description: "A privacy-conscious LLM reading and translation assistant.",
    version: "0.1.0",
    manifest_version: 3,
    permissions: ["storage", "contextMenus", "notifications", "activeTab", "scripting"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "悠悠阅读助手",
    },
  },
});
