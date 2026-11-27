# Luma Studio

Luma Studio 支持浏览器内调色、美颜和局部 AI 编辑。M3 的 AI 生成功能需要 Node.js 22 或以上版本来运行本地代理，无需安装 npm 依赖。

```powershell
node server.mjs
```

在项目根目录启动后，打开 [本地工作区](http://127.0.0.1:4173)。在未配置供应商时，也可以使用调色、美颜、编辑历史和 PNG 导出。

## 启用局部 AI 编辑

启动代理前设置以下环境变量。启动后可在界面的“AI 接口设置”核对目标和模型。

| 变量 | 用途 |
| --- | --- |
| `IMAGE_EDIT_BASE_URL` | HTTPS API 根地址（例如 `https://api.openai.com/v1`），代理会追加 `/images/edits` |
| `IMAGE_EDIT_MODEL` | 此供应商支持蒙版编辑的 GPT Image 兼容模型 |
| `IMAGE_EDIT_API_KEY` | 供应商密钥，通过启动环境注入 |
| `PORT` | 可选，本机端口，默认 `4173` |

导入图片后，打开“局部 AI”，用笔刷、橡皮、套索或矩形准备选区，再输入指令并点击“生成预览”。可以比较前后、放弃预览、重新打开生成历史中的结果，或将结果应用到可撤销的编辑历史。

代理只监听本机。只有生成或重试时才会向配置的供应商转发原图的等比例 PNG 副本、蒙版和指令。适配器以 multipart 的 `image[]`、`mask` 字段发送图片，接收与请求尺寸一致的 `data[0].b64_json` PNG 响应。点击取消会中止本地请求和等待，供应商可能已经开始计费。每张图片在当前会话中最多保留 12 条成功生成记录。应用结果按蒙版合成到画布，导出保留原图分辨率，生成区域的细节取决于供应商输出尺寸。

使用 `node --test` 运行本地代理回归测试。安装 Chrome 并将 `LUMA_PLAYWRIGHT_PATH` 设为 `playwright-core/index.mjs` 的绝对路径后，同一命令还会运行模拟供应商的浏览器测试。详细的产品设计见 [产品路线图](docs/product-roadmap.md)。
