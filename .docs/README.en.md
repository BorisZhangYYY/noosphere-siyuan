# ZhiLiu for SiYuan · 知流

[简体中文](../README.md)

Capture web articles inside SiYuan, optionally review them with AI, edit them with SiYuan's native block editor, and save the text, source metadata and images to your workspace.

**Web capture requires a Firecrawl API key. AI review is optional and requires your own model service configuration.** The plugin interface is primarily in Simplified Chinese; AI output can use the source language, Simplified Chinese or English.

## Features

- Capture article text, images and available source metadata from a public URL.
- Keep the captured original or review it with a configured model, perspective, output language and article format.
- Edit inside the existing dialog with SiYuan's native block editor. Confirming an edit keeps it in the plugin; saving imports it into a SiYuan document.
- Optionally review images, then manually restore or remove them before saving. Downloaded images go to SiYuan's asset directory; failed downloads retain their original links.
- Preserve source metadata in separate paragraphs and keep searchable article history with processing results and destination choices.
- Set the actual document title when saving to an empty unnamed document. Append an article to an existing document without replacing its content.

WeChat captures can fill missing author and publication fields from explicit article metadata and remove reader or comment interface text. Old and new Xiaoheihe share links are normalized to article URLs, with title cleanup and recovery. Recognized article cards provide missing author and date fields; comments and recommendations are removed while article images and polls are preserved. Zhihu login or verification pages are reported as capture failures.

## Requirements

Requires **SiYuan 3.8.6 or later**. The declared environments are Windows, macOS and Linux desktop clients, desktop windows, and desktop browser frontends, including Docker deployments. Mobile clients and SiYuan publishing-service pages are outside the supported scope.

## Quick start

![ZhiLiu workbench: capture at the top, article editing on the left, AI review and images on the right, and the save destination at the bottom right](https://raw.githubusercontent.com/BorisZhangYYY/noosphere-siyuan/main/.docs/images/workbench.png)

Capture new articles at the top, read and edit the body on the left, and review with AI or manage images on the right. The save destination stays at the bottom right. Use Settings in the top-right corner to configure services.

1. Open the globe icon in SiYuan's top toolbar.
2. Configure your Firecrawl API key. Configure text and optional vision models if you want AI review.
3. Paste a URL at the top and capture it. Inspect the article on the left; click Edit to make changes, then Confirm to keep them.
4. Optionally choose a review perspective and output language on the right, then start AI review. Click an image thumbnail to inspect it and select its checkbox to remove it.
5. In manual mode, copy the destination **document ID** from SiYuan, enter it at the bottom right, and save the article.
6. Open **Classification configuration** at the far right of the workbench tabs (marked AI), then enter a **notebook or root-document ID** as the anchor and save. Select automatic classification in the article save area. Destination fields are hidden in automatic mode; change the root only in Classification configuration. Once both text and image review finish successfully, the article is classified and saved automatically. Cancellation or review failure does not save it; a failed save keeps the completed review for retry.

### Prepare categories

- The category list appears directly below the location in Classification configuration. Add category and Edit open a form; choose a parent using the dropdown and write a description, or generate a draft with AI. Generation uses only the current category name and parent path, focusing on its topics, scope, and typical articles without comparisons or redirection to other categories. Confirm synchronization to write the category and description to SiYuan.
- A selected root document contains the managed directory followed by usage instructions. Open root document appears beside the root ID field under Classification location and opens the currently entered location independently of the category list. When SiYuan's top-level notebook document feature is enabled, a notebook anchor uses its own root document. Older versions or disabled notebook documents still support notebook-wide classification without creating a separate overview. Category pages are locked by default; use Category management or unlock them in SiYuan to edit the description. Renaming a marked heading preserves its identity.
- Root and category directories recursively show all descendant documents in SiYuan's order, including articles and unmarked folders. Index pages use 📚 and bold titles; content pages use 📄 and regular titles. Titles remain native dynamic references. Root instructions use eight short bullet points. Enable automatic directory creation to append a managed index below each category introduction on its first article save. Alternatively, mark an existing list block with a nonempty `custom-zl-index` attribute. Saving or opening the document refreshes its marked index; a failed refresh can be retried separately.
- Unmatched articles and classification-service failures save into a separate article document at the anchor root, with an explanation. Repeated saves of the same source update the existing article, even after a title change. Different sources with identical titles get separate document names; unrelated notes are preserved.

Perspectives and article formats apply when you start AI review. Captured articles can also be saved directly. The original-author and novice perspectives are built in, read-only and cannot be deleted; add a custom perspective to make adjustments.

Choose the output language in the workbench: follow the SiYuan interface (default), keep the source language, Simplified Chinese or English. The choice belongs to the current article and is retained in its history. New articles default to the interface language; an empty workbench also lets you choose a language before capturing. You can add, rename and delete named custom providers with separate credentials and models; built-in providers cannot be deleted.

Use Save beside the Settings heading; it stays visible while scrolling and keeps you on the settings page. After the status shows saved, use Return to Workbench. Empty API keys start visible while typing; stored keys start hidden and the eye button toggles visibility.

Drag providers to reorder them, then save Settings to keep the order. You can also focus a provider and use Alt/Option + Up/Down.

The plugin creates no extra draft documents or notebooks. Manual mode retains per-article destinations and appends imports. Automatic mode remembers the anchor and updates the same source article. Changes made after an automatic save can be saved again with Save Article.

Changes between versions are recorded in the [Changelog](https://github.com/BorisZhangYYY/noosphere-siyuan/blob/main/CHANGELOG.md).

## Services and data

Capture sends the URL to Firecrawl. AI review sends the article text to your configured text model; automatic classification also sends category paths, descriptions and an article excerpt to that model; vision review sends images and an article summary to your configured image model. Service charges and quotas are determined by the providers.

Settings, API keys and article records are stored in the current workspace's plugin storage. Imported text and downloaded images are stored in SiYuan documents and assets. Closing, disabling or upgrading the plugin preserves article records.

## Development

See [Development environment and architecture](../.project/development.md) for the project structure, processing flow and build instructions.

## Feedback and contributions

Report problems or suggestions through [Issues](https://github.com/BorisZhangYYY/noosphere-siyuan/issues). Read the [feedback and contribution guidelines](../CONTRIBUTING.md) before submitting.

Licensed under [MIT](https://github.com/BorisZhangYYY/noosphere-siyuan/blob/main/LICENSE).

## Acknowledgements

- [SiYuan](https://github.com/siyuan-note/siyuan) for its block editor, plugin APIs, and document and asset management.
- [Firecrawl](https://www.firecrawl.dev/) for web article and metadata extraction.
