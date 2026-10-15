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

## Requirements

Requires **SiYuan 3.8.6 or later**. The declared environments are Windows, macOS and Linux desktop clients, desktop windows, and desktop browser frontends, including Docker deployments. Mobile clients and SiYuan publishing-service pages are outside the supported scope.

## Quick start

![ZhiLiu workbench: capture at the top, article editing on the left, AI review and images on the right, and the save destination at the bottom right](https://raw.githubusercontent.com/BorisZhangYYY/noosphere-siyuan/main/.docs/images/workbench.png)

Capture new articles at the top, read and edit the body on the left, and review with AI or manage images on the right. The save destination stays at the bottom right. Use Settings in the top-right corner to configure services.

1. Open the globe icon in SiYuan's top toolbar.
2. Configure your Firecrawl API key. Configure text and optional vision models if you want AI review.
3. Paste a URL at the top and capture it. Inspect the article on the left; click Edit to make changes, then Confirm to keep them.
4. Optionally choose a review perspective and output language on the right, then start AI review. Click an image thumbnail to inspect it and select its checkbox to remove it.
5. Copy the destination **document ID** from SiYuan, enter it at the bottom right, and save the article.

The plugin creates no draft documents, notebooks or folders. Each article keeps its own destination choice. Saving changed content to an existing document appends another import; it does not synchronize with an earlier import.

Changes between versions are recorded in the [Changelog](https://github.com/BorisZhangYYY/noosphere-siyuan/blob/main/CHANGELOG.md).

## Services and data

Capture sends the URL to Firecrawl. AI review sends the article text to your configured text model; vision review sends images and an article summary to your configured image model. Service charges and quotas are determined by the providers.

Settings, API keys and article records are stored in the current workspace's plugin storage. Imported text and downloaded images are stored in SiYuan documents and assets. Closing, disabling or upgrading the plugin preserves article records.

## Development

See [Development environment and architecture](../.project/development.md) for the project structure, processing flow and build instructions.

## Feedback and contributions

Report problems or suggestions through [Issues](https://github.com/BorisZhangYYY/noosphere-siyuan/issues). Read the [feedback and contribution guidelines](../CONTRIBUTING.md) before submitting.

Licensed under [MIT](https://github.com/BorisZhangYYY/noosphere-siyuan/blob/main/LICENSE).

## Acknowledgements

- [SiYuan](https://github.com/siyuan-note/siyuan) for its block editor, plugin APIs, and document and asset management.
- [Firecrawl](https://www.firecrawl.dev/) for web article and metadata extraction.
