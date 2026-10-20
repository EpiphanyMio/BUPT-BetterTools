# MarkItDown 转换服务（PythonAnywhere）

该服务只做一件事：接收 BetterTools Worker 转发的 PDF/DOCX，用微软 MarkItDown 转成 Markdown，再立即删除临时文件。AI API Key 不会发送到 PythonAnywhere。

## 1. 创建环境

在 PythonAnywhere 的 Bash Console 中执行：

```bash
mkdir -p ~/markitdown-api
cd ~/markitdown-api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

把本目录的 `app.py` 和 `requirements.txt` 上传到 `~/markitdown-api/`。

## 2. 创建 Web App

在 PythonAnywhere 的 Web 页面创建 **Manual configuration** 的 Python Web App：

1. Virtualenv 填 `/home/YOUR_USERNAME/markitdown-api/.venv`。
2. 打开 WSGI 配置，把 `wsgi.py.example` 的内容复制进去。
3. 修改用户名路径，并把 `CONVERTER_API_SECRET` 换成随机长字符串。
4. Reload Web App。

健康检查：

```text
GET https://YOUR_USERNAME.pythonanywhere.com/health
```

应返回 `{"ok":true}`。

## 3. 配置 Cloudflare Worker

在本机项目目录执行，密钥必须与 WSGI 中相同：

```bash
npx wrangler secret put MARKITDOWN_API_URL
# 输入：https://YOUR_USERNAME.pythonanywhere.com/api/convert

npx wrangler secret put MARKITDOWN_API_SECRET
# 输入：WSGI 中的随机长字符串
```

然后重新部署 Worker。不要把这两个值写进仓库或 `wrangler.jsonc`。

## 限制

- 单文件最多 15 MB。
- 支持文字型 PDF 和 DOCX。
- 旧版 `.doc` 请先用 Word/WPS 另存为 `.docx`。
- 扫描版 PDF 没有文本层，需要后续接 OCR。
- PythonAnywhere 免费 Web App 需要定期登录延长，一个 Worker 会顺序处理请求。
