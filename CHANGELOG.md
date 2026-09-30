# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，并采用 [Semantic Versioning](https://semver.org/lang/zh-CN/) 进行版本管理。

## [Unreleased]

### Added
- 初始化项目结构与开发规范。
- 提供思源插件形态的文章采集入口，支持 Firecrawl 抓取和正文预览编辑。
- 支持配置模型服务进行可选的 AI 审阅，并可将文章直接追加到指定思源文档。
- 支持将文章图片保存到思源资源目录，并显示处理状态与错误。
- 支持从顶部按钮、快捷键和命令面板打开采集窗口。
- 支持使用 Anthropic Messages 兼容模型进行文章审阅。

### Changed

### Fixed
- 已含标题的审阅稿写入思源时不再重复插入文章标题。
