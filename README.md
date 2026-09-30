# Noosphere for SiYuan · 知流

> 一个独立运行于思源笔记中的开源 AI 内容采集与知识沉淀插件。

---

## 项目简介

Noosphere for SiYuan 面向思源笔记用户，将网页内容抓取、正文清洗、AI Review、图片本地化与文档写入整合为一条完整的知识摄取流程。

项目借鉴 Noosphere 的内容处理与知识沉淀理念，但**不要求用户安装或部署 Noosphere**。插件自身保持独立运行，并通过可扩展 Adapter 对接抓取服务与 LLM Provider。

## 核心特性

- **独立运行**：安装 SiYuan 插件即可使用，不依赖 Noosphere Server。
- **内容摄取**：从 URL 抓取正文、元数据与图片，并整理为适合知识库保存的内容。
- **AI Review**：通过可配置的 OpenAI Chat Completions 或 Anthropic Messages 兼容模型审阅正文，也可跳过此步手动编辑。
- **知识落库**：将处理后的文章直接追加到指定思源文档 ID。
- **可扩展架构**：Crawler、LLM Provider、Review Pipeline 与 SiYuan Writer 保持模块化。

## 适用场景

- 在思源笔记内保存和整理微信公众号、知乎及普通网页内容。
- 将长文章先经过 AI Review，再沉淀进个人知识库。
- 希望内容和图片最终归档在自己的 SiYuan 数据中，而不是依赖第三方知识 SaaS。

## 核心流程

```text
URL
 ↓
Crawler Adapter
 ↓
Content Normalize
 ↓
AI Review
 ↓
Image Localization
 ↓
SiYuan Document
```

## v0.1.0 MVP 预览版

本版通过 [GitHub Releases](https://github.com/BorisZhangYYY/noosphere-siyuan/releases) 提供安装包，暂不在思源集市发布。采集窗口的完整交互链路仍需继续验证，已知问题记录在 [TODO.md](TODO.md)。

- [x] 初始化可构建的 SiYuan 插件工程
- [x] 使用 Firecrawl 抓取 URL 正文与元数据
- [x] 配置兼容 OpenAI Chat 或 Anthropic Messages 的模型、API 地址与审阅指令
- [x] 抓取预览、手动编辑、可选 AI 审阅
- [x] 图片本地化；失败时保留原链接
- [x] 写入指定思源文档 ID 或当前打开的文档
- [x] 阶段状态与错误提示

安装和使用步骤见 [.docs/usage.md](.docs/usage.md)。

## 项目结构

首版按以下职责拆分：

```text
noosphere-siyuan/
├── src/
│   ├── crawler/       # 内容抓取 Adapter
│   ├── review/        # LLM Provider 与审阅
│   ├── article/       # 文档组装
│   ├── images/        # 图片下载与本地化
│   └── siyuan/        # SiYuan API 与文档写入
├── .docs/             # 面向使用者的文档
├── .project/          # 仓库内部开发规范与设计记录
├── CLAUDE.md
├── TODO.md
└── CHANGELOG.md
```

## 设计原则

1. SiYuan 插件必须可以独立运行。
2. Noosphere 是设计来源之一，而不是运行时依赖。
3. 优先复用成熟抓取与模型服务，不重复制造无差异底层组件。
4. 用户处理后的知识最终应保存在自己的 SiYuan 数据中。
5. 外部服务通过 Adapter 接入，避免绑定单一供应商。

## 贡献指南

欢迎提交 Issue 与 PR。开发前请阅读 `CLAUDE.md`、`TODO.md` 与 `CHANGELOG.md`。

## 许可证

计划采用 MIT License。

## 相关链接

- Noosphere：https://github.com/BorisZhangYYY/Noosphere
- SiYuan：https://github.com/siyuan-note/siyuan
