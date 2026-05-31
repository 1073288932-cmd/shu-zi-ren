# 知识库（物理教材 RAG）

- 把教材 markdown 放到 `knowledge/textbooks/*.md`（每文件一本；可在文件头加 front-matter `textbook: 人教版 八年级下` 指定教材名，否则用文件名）。
- 运行 `npm run build-kb` 生成 `knowledge/index.json`（需 `.env` 里有 `SILICONFLOW_API_KEY`）。
- `textbooks/` 与 `index.json` 已 gitignore（出版物文本 + 体积，不入仓）。
- 改 embedding 模型 / chunk 参数后需重跑 build-kb；旧 index 会被运行时自动降级（不会误用）。
- **打包前必须先跑 build-kb**，否则打出的 app 没有知识库。
