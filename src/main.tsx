// 这是整个网页的入口文件。
// 它做的事：找到 index.html 里的 <div id="root">，把 <App /> 渲染进去。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
// 本地字体的 @font-face 声明不在这里引入 —— 它在 index.html 里用 <link> 加载。
// 原因：那份 CSS 注册了 110 个字体分片，约 300KB 文字。
// 打进这个样式包会让首屏 CSS 大十倍；用 <link> 则能让它作为独立文件并行下载，
// 而且用户的浏览器缓存里只留一份（见 index.html 里的说明）。
import './index.css'

// document.getElementById('root')! 末尾的 ! 表示"我确定它存在"
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
