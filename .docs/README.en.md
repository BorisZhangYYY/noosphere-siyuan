# ZhiLiu for SiYuan · 知流

[简体中文](../README.md)

Capture web articles in SiYuan, optionally review them with AI, edit them with the native editor, and automatically classify them. Save the text, sources and images to your workspace.

## Features

- **Web capture**: Extract article text, images and available source metadata, such as the author and publication date.
- **Review and editing**: Choose an AI review perspective, language and format, or edit the original with SiYuan's native editor.
- **Image management**: Filter images with AI or adjust them manually. Saving attempts to download images to SiYuan's asset directory.
- **Automatic classification**: File articles by category name, path and description, with nested categories and automatically updated directories.
- **History**: Keep originals, processed drafts and save destinations. Search, resume editing or open saved documents at any time.

## Quick start

![ZhiLiu workbench: capture at the top, edit on the left, and review, manage images and save on the right](https://raw.githubusercontent.com/BorisZhangYYY/noosphere-siyuan/main/.docs/images/workbench.png)

1. Install and enable the plugin, then click the globe icon in SiYuan's top toolbar.
2. Open **Settings** at the top right and enter your **Firecrawl API key**. Configure a text model and an optional vision model for AI features.
3. Paste a URL and click **Capture Article**. To change the text, click **Edit**, then **Confirm** when finished.
4. Optionally choose a review perspective, output language and article format, then click **AI Review**. You can also save the original directly.
5. Under **Save Destination**, choose **Manual**, enter the **document ID** copied from SiYuan's document menu, and click **Save Article**. For automatic filing, follow the steps below.

## Automatic classification

Create categories first. ZhiLiu uses their names, full paths and descriptions to save reviewed articles under a suitable category.

![ZhiLiu classification configuration: set the root, enable directory maintenance, and manage category names and descriptions](https://raw.githubusercontent.com/BorisZhangYYY/noosphere-siyuan/main/.docs/images/classify.png)

1. Open **Classification Configuration** at the far right of the workbench tabs. Enter a **notebook or root-document ID**, optionally enable **Automatically create and maintain category directories**, and click **Save**.
2. Under **Category Management**, click **Add Category**, fill in the name, parent category and description, then click **Create and Sync**. Write the description yourself or generate it with AI; it is written to SiYuan only after you confirm synchronization.
3. Return to **Current Article**, switch the save mode to **Automatic Classification**, and click **AI Review**. Once text and image review finish, the article is filed automatically without another save click.

Descriptions define what each category accepts. Edit them in Category Management or the SiYuan document; changes apply to the next classification. Only categories within the selected root are considered. If no category fits or the classification service fails, the article is saved directly under the root with an explanation.

With directory maintenance enabled, category pages show clickable, nested directories that update when documents are created, renamed, moved or deleted. Category index pages are locked by default; unlock them from SiYuan's document menu to edit directly. Articles remain editable.

## Usage notes

- **Review and language**: Follow the SiYuan interface language, keep the source language, or choose Simplified Chinese or English. Built-in perspectives are read-only; you can add custom perspectives.
- **Images**: Click to preview in read-only mode. While editing, click to select multiple images, double-click to preview, and use **Add** or **Remove** to adjust the body. Removed originals remain available; failed downloads retain their original links.
- **Manual saving**: **Confirm** keeps your edits in the plugin; **Save Article** writes them to SiYuan. Saving appends to an existing document or sets the title of an empty unnamed document.
- **Automatic saving**: Saving the same source again updates the existing article. Cancellation or review failure prevents automatic saving; a failed save keeps the reviewed draft for retry. Images or links marked for confirmation must be checked before saving manually.
- **History**: Closing the window, disabling or upgrading the plugin preserves records. If a SiYuan document is deleted, its article remains available in history for saving again.

See the [Changelog](https://github.com/BorisZhangYYY/noosphere-siyuan/blob/main/CHANGELOG.md) for version changes.

## Requirements

Requires **SiYuan 3.8.6 or later**. Supports Windows, macOS and Linux desktop clients and desktop browser frontends, including Docker deployments. Mobile clients and SiYuan publishing-service pages are not currently supported.

## Services and data

Web capture uses Firecrawl. AI review, classification and image filtering use your configured model services, whose providers determine fees and quotas. Depending on the feature, URLs, article text, category information or images are sent to the corresponding service.

Settings, API keys and article records are stored in the current SiYuan workspace's plugin storage. Saved text and downloaded images are stored in SiYuan documents and assets.

## Development and feedback

See [Development environment and architecture](../.project/development.md) for development details. Report problems or suggestions through [Issues](https://github.com/BorisZhangYYY/noosphere-siyuan/issues), and read the [contribution guidelines](../CONTRIBUTING.md) before contributing.

Licensed under [MIT](https://github.com/BorisZhangYYY/noosphere-siyuan/blob/main/LICENSE).

## Acknowledgements

- [SiYuan](https://github.com/siyuan-note/siyuan) for its editor, plugin APIs and document management.
- [Firecrawl](https://www.firecrawl.dev/) for web article and metadata extraction.
- [siyuan-plugins-index](https://github.com/Szerelem0617/siyuan-plugins-index) for open-source code and mechanisms used as a reference for category directories. No separate installation is required.
