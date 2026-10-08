# tech-insight 技术洞察系统

每日跟踪技术社区、学术论文、科技公司动态，LLM 摘要打标后归档到本仓库，GitHub Pages 提供浏览界面。

## 结构

```
index.html            浏览前端（单文件 SPA，读 leads/manifest.json）
leads/                结构化线索（每条：中文摘要 / 标签 / 来源链接 / 评分）
  manifest.json       全量线索清单（前端数据源）
daily/                每日 Markdown 日报
reviews/              人工审核评价（预留）
src (fetch.mjs 等)    抓取与构建脚本，见 scripts 说明
```

## 数据流水线

1. `node fetch.mjs` — 抓取 19 个信息源（HN、GitHub Trending、arXiv、HF Papers、TechCrunch、IEEE Spectrum、机器之心等），去重打分，输出原始数据
2. LLM 摘要打标 → 生成 `leads/YYYY-MM-DD.json` + `daily/YYYY-MM-DD.md`
3. `node build-manifest.mjs` — 重建全量清单
4. git push → GitHub Pages 自动更新

## 人工审核

在前端页面对每条线索评价（有价值 / 已了解 / 不重要 + 评语）。v1 评价保存在浏览器并可一键导出 JSON 放入 `reviews/`；后续将支持 GitHub API 直接写回。
