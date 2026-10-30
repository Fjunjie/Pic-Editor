# Luma Studio

M1 的浏览器端图片调色工作区。无需安装依赖：使用任意静态 HTTP 服务器打开 `dist/index.html`，例如：

```powershell
py -m http.server 4173 --directory dist
```

随后访问 `http://localhost:4173`。详细的产品设计与后续里程碑见 [docs/product-roadmap.md](docs/product-roadmap.md)。

> M1 在浏览器内处理图片像素：为保证预览流畅，大图预览最长边限制为 2400px；导出 PNG 时仍会以原始图片分辨率重新渲染。设置中的 API Key 不会被保存或发送。真实的 AI 编辑和美颜功能属于后续里程碑。
