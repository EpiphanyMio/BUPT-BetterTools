import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite 的配置文件：告诉打包工具"用 React 插件 + Tailwind 插件"
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // 开发时的接口代理。
  //
  // 为什么需要它：线上是同一个 Worker 同时提供网页和 /api（同源，不需要跨域）。
  // 但开发时前端跑在 Vite（5173）、API 跑在 wrangler dev（8787），是两个不同的源。
  // 有了这条代理，前端代码里永远只写 fetch("/api/...")，
  // 开发和生产用的是同一行代码，不用在两边写不同的地址。
  server: {
    proxy: {
      // wrangler dev 默认监听 127.0.0.1（IPv4），这里显式写上，避免走到 IPv6
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
})