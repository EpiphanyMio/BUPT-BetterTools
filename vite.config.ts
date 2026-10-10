import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite 的配置文件：告诉打包工具"用 React 插件 + Tailwind 插件"
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
