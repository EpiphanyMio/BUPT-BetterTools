import hmac
import os
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request
from markitdown import MarkItDown
from werkzeug.utils import secure_filename


app = Flask(__name__)
# Worker 已把文件本体卡在 15MB；这里多留 1MB 给 multipart 边界和字段开销。
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

CONVERTER_API_SECRET = os.environ.get("CONVERTER_API_SECRET", "")
ALLOWED_EXTENSIONS = {".pdf", ".docx"}
converter = MarkItDown(enable_plugins=False)


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/api/convert")
def convert_document():
    supplied_secret = request.headers.get("X-Converter-Key", "")
    if not CONVERTER_API_SECRET or not hmac.compare_digest(supplied_secret, CONVERTER_API_SECRET):
        return jsonify({"error": "unauthorized"}), 401

    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify({"error": "missing-file"}), 400

    filename = secure_filename(uploaded.filename or "")
    extension = Path(filename).suffix.lower()
    if not filename or extension not in ALLOWED_EXTENSIONS:
        return jsonify({"error": "unsupported-format"}), 415

    try:
        # 每次请求使用独立临时目录；响应结束后自动删除原文件和转换过程产生的内容。
        with tempfile.TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / filename
            uploaded.save(file_path)
            result = converter.convert(str(file_path))
            markdown = result.markdown
    except Exception:
        app.logger.exception("MarkItDown conversion failed")
        return jsonify({"error": "conversion-failed"}), 422

    if not markdown.strip():
        return jsonify({"error": "empty-document"}), 422
    return jsonify({"filename": filename, "markdown": markdown})


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify({"error": "payload-too-large"}), 413
