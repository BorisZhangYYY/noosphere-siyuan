/** Markup for onboarding and the article workbench. */
const formatOptions = [
  ["openai_chat", "OpenAI 兼容 · Chat Completions"],
  ["openai_responses", "OpenAI · Responses"],
  ["anthropic", "Anthropic · Messages"],
  ["google", "Google · Gemini"],
] as const;
const perspectiveOptions = [
  ["raw", "原文"],
  ["original", "基于原文"],
  ["novice", "小白视角"],
] as const;
import { OUTPUT_LANGUAGE_OPTIONS } from "./review/language";

/** 与网页端一致的来源、审阅和素材分区，图标跟随思源主题。 */
function railIcon(kind: "source" | "review" | "assets" | "save"): string {
  const paths = { source: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>', review: '<path d="m4 20 12-12 4 4L8 24M14 3v3M21 5h3M3 10h3M19 19v3"/>', assets: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 6-5 4 3 4-5 4 7"/>', save: '<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>' };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>`;
}

function dropdown(name: string, label: string, options: readonly (readonly [string, string])[]): string {
  return `<div class="noosphere__field">${label ? `<span class="noosphere__field-label">${label}</span>` : ""}<div class="noosphere__dropdown" data-dropdown="${name}"><input type="hidden" data-field="${name}"><button class="noosphere__dropdown-trigger" data-select-trigger="${name}" type="button" aria-label="${label || "审阅视角"}" aria-haspopup="listbox" aria-expanded="false"><span data-select-label="${name}">${options[0][1]}</span><svg class="noosphere__chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg></button><div class="noosphere__dropdown-menu" role="listbox" hidden>${options.map(([value, text]) => `<button type="button" role="option" data-select-option="${name}" data-value="${value}">${text}</button>`).join("")}</div></div></div>`;
}

function secret(name: string, placeholder = ""): string {
  return `<div class="noosphere__secret"><input data-field="${name}" class="b3-text-field" type="password" autocomplete="off" placeholder="${placeholder}"><span class="noosphere__secret-preview" aria-hidden="true"></span><button type="button" data-reveal="${name}" aria-label="显示密钥" aria-pressed="false" title="显示密钥"><svg class="noosphere__eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg><svg class="noosphere__eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/><path d="m3 3 18 18"/></svg></button></div>`;
}

export function captureContent(): string {
  return `<div class="noosphere">
    <main class="noosphere__setup" data-view="setup" hidden>
      <div class="noosphere__page-heading"><h2>设置</h2></div>
      <section class="noosphere__panel"><div class="noosphere__panel-title"><h3>抓取服务</h3><span>必填</span></div>
        <label>Firecrawl API Key${secret("firecrawlKey", "fc-...")}</label>
        <p class="noosphere__field-help">还没有密钥？前往 <a href="https://www.firecrawl.dev/app/api-keys" target="_blank" rel="noopener noreferrer">Firecrawl API Keys</a> 注册、创建并复制密钥。</p>
      </section>
      <section class="noosphere__panel"><div class="noosphere__panel-title"><h3>AI 审阅</h3><span>可选</span></div>
        <div class="noosphere__provider-heading"><h4>模型供应商</h4><button data-action="addProvider" class="b3-button b3-button--outline" type="button">新增供应商</button></div>
        <div class="noosphere__provider-create" data-role="providerCreator" hidden><label>供应商名称<input data-field="newProviderName" class="b3-text-field" maxlength="40" placeholder="例如 My Gateway"></label><button data-action="createProvider" class="b3-button" type="button">创建供应商</button><button data-action="cancelProvider" class="b3-button b3-button--outline" type="button">取消</button><p data-role="providerError" role="alert" hidden></p></div>
        <input type="hidden" data-field="modelProvider">
        <div class="noosphere__provider-workspace"><nav class="noosphere__provider-list" data-role="providerList" aria-label="模型供应商"></nav><div class="noosphere__provider-detail">
        <div class="noosphere__provider-identity"><p data-role="providerDescription"></p><button data-action="deleteProvider" class="b3-button b3-button--outline" type="button" hidden>删除供应商</button></div>
        <label data-role="providerName" hidden>供应商名称<input data-field="providerName" class="b3-text-field" maxlength="40"></label>
        <div class="noosphere__provider-fields">
          <label>API Key${secret("modelKey")}</label>
          <div class="noosphere__model-row"><label>模型<input data-field="modelName" class="b3-text-field" placeholder="输入模型 ID，或获取可用模型"></label><button data-action="listModels" class="b3-button b3-button--outline" type="button">获取模型</button></div>
          ${dropdown("modelFormat", "接口协议", formatOptions)}
          <label>API 地址<input data-field="modelBaseUrl" class="b3-text-field" type="url" placeholder="https://api.example.com/v1"></label>
          <div class="noosphere__model-results" data-role="modelResults" hidden><span data-role="modelResultsLabel"></span><input data-role="modelSearch" class="b3-text-field" type="search" aria-label="筛选模型" placeholder="筛选模型名称"><div data-role="modelOptions" class="noosphere__model-options"></div></div>
          <label class="noosphere__vision-option"><input data-field="modelVisionCapable" type="checkbox"> 这个模型支持识图</label>
        </div>
        </div></div>
        ${dropdown("outputLanguage", "默认文章输出语言", OUTPUT_LANGUAGE_OPTIONS)}<p class="noosphere__field-help">用于新抓取的文章；当前文章可在工作台单独调整。</p>
        <div class="noosphere__image-provider">${dropdown("imageProvider", "图片审阅模型", [["", "关闭图片审阅"]])}<p>可从已标记“支持识图”的供应商中选择；与文字审阅模型可以不同。识别失败的图片会保留。</p></div>
        <section class="noosphere__perspective-editor"><div class="noosphere__perspective-heading"><div><h4>审阅视角与文章格式</h4><p>新增视角后，像给编辑提要求一样描述文章结构。</p></div><div class="noosphere__perspective-buttons"><button data-action="addPerspective" class="b3-button b3-button--outline" type="button">新增视角</button><button data-action="deletePerspective" class="b3-button b3-button--outline" type="button" hidden>删除视角</button></div></div>
          ${dropdown("reviewPerspective", "", perspectiveOptions)}
          <div class="noosphere__perspective-meta" data-role="perspectiveMeta" hidden><label>视角名称<input data-field="perspectiveLabel" class="b3-text-field" maxlength="80"></label><label>描述<input data-field="perspectiveDescription" class="b3-text-field" maxlength="400"></label></div>
          <div class="noosphere__prompt-tabs"><button data-action="perspectiveTab" class="is-active" type="button">视角提示词</button><button data-action="templateTab" type="button">文章格式要求</button></div>
          <div data-role="perspectivePrompt"><textarea data-field="perspectiveEditor" class="b3-text-field noosphere__perspective-textarea" spellcheck="false" aria-label="视角提示词"></textarea></div>
          <div class="noosphere__format-editor" data-role="templateBuilder" hidden><textarea data-field="templateEditor" class="b3-text-field noosphere__perspective-textarea" spellcheck="false" aria-label="文章格式要求"></textarea></div>
        </section>
      </section>
      <div class="noosphere__setup-footer"><button data-action="settings" class="b3-button noosphere__primary" type="button">保存并进入工作台</button></div>
    </main>
    <main class="noosphere__workbench" data-view="workbench" hidden>
      <nav class="noosphere__work-tabs" aria-label="工作台视图"><button data-action="showCapture" type="button" class="is-active" aria-pressed="true">当前文章</button><button data-action="showHistory" type="button" aria-pressed="false">历史记录 <span data-role="historyCount">0</span></button></nav>
      <section class="noosphere__capture" aria-label="文章抓取"><div class="noosphere__url-row"><input data-field="url" class="b3-text-field" type="url" inputmode="url" aria-label="新文章链接" placeholder="粘贴新文章链接 https://…"><button data-action="scrape" class="b3-button noosphere__primary" type="button">抓取文章</button></div></section>
      <div class="noosphere__work-content">
        <section class="noosphere__review-panel" aria-label="正文阅读区">
          <div class="noosphere__article-toolbar"><span data-role="articleMeta">文章正文</span><div><span class="noosphere__readonly" data-role="articleMode">只读</span><button data-action="editArticle" class="b3-button b3-button--outline" type="button">编辑</button><button data-action="confirmArticle" class="b3-button" type="button" hidden>确定</button></div></div>
          <div class="noosphere__stream-notice" data-role="streamNotice" hidden><span>正在生成审阅稿</span><button data-action="followStream" type="button" aria-pressed="true">跟随输出</button></div>
          <div class="noosphere__article-scroll" data-role="articleScroll"><div data-role="empty" class="noosphere__empty"><strong>等待抓取</strong><span>粘贴文章链接，开始阅读</span></div><article data-role="articlePreview" class="b3-typography noosphere__article-preview" aria-label="文章正文" hidden></article><div data-role="articleEditor" class="noosphere__native-editor" aria-label="思源文章编辑器" hidden></div></div>
        </section>
        <aside class="noosphere__inspection" aria-label="文章信息与操作">
          <div class="noosphere__inspection-scroll">
            <details class="noosphere__rail-card noosphere__source"><summary>${railIcon("source")}<h3>来源</h3><span data-role="sourceSummary">—</span><svg class="noosphere__chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg></summary><dl><div><dt>平台</dt><dd data-role="sourcePlatform">—</dd></div><div><dt>作者</dt><dd class="noosphere__source-field"><span data-role="sourceAuthorText">未填写</span><input hidden data-field="sourceAuthor" class="noosphere__metadata-input" aria-label="作者" placeholder="填写作者" maxlength="160"></dd></div><div><dt>发布时间</dt><dd class="noosphere__source-field"><span data-role="sourcePublishedText">未填写</span><input hidden data-field="sourcePublished" class="noosphere__metadata-input" aria-label="发布时间" placeholder="YYYY-MM-DD" maxlength="80"></dd></div><div class="noosphere__source-time"><dt data-role="sourceTimeLabel">抓取时间</dt><dd data-role="sourceCaptured">—</dd></div></dl><div class="noosphere__source-actions"><a data-role="sourceLink" target="_blank" rel="noopener noreferrer" hidden>打开原文 ↗</a><button data-action="editSource" class="b3-button b3-button--outline" type="button">编辑</button><button data-action="confirmSource" class="b3-button b3-button--outline" type="button" hidden>确定</button></div></details>
            <section class="noosphere__rail-card"><div class="noosphere__rail-title">${railIcon("review")}<h3>AI 审阅</h3><span data-role="reviewState">待审阅</span></div><p class="noosphere__rail-note" data-role="reviewInfo">选择视角，整理当前文章。</p><div class="noosphere__review-actions">${dropdown("workPerspective", "审阅视角", perspectiveOptions)}${dropdown("workOutputLanguage", "输出语言", OUTPUT_LANGUAGE_OPTIONS)}<div class="noosphere__review-progress" data-role="reviewProgress" aria-live="polite" hidden><div><span data-role="reviewProgressLabel"></span><strong data-role="reviewProgressDetail"></strong></div><progress data-role="reviewProgressBar" max="100" aria-label="AI 审阅进度"></progress></div><button data-action="review" class="b3-button b3-button--outline" type="button">AI 审阅</button><button data-action="cancelReview" class="b3-button b3-button--outline" type="button" hidden>取消审阅</button></div><p class="noosphere__status" data-role="status" role="status" aria-live="polite" hidden><span data-role="statusText"></span></p></section>
            <section class="noosphere__rail-card noosphere__assets" data-role="imageDecisions"><div class="noosphere__rail-title">${railIcon("assets")}<h3>素材</h3><span data-role="assetCount">0</span></div><p class="noosphere__rail-note" data-role="imageDecisionCount">抓取后展示文章图片。</p><div data-role="imageDecisionList" class="noosphere__asset-grid"></div></section>
          </div>
          <section class="noosphere__rail-card noosphere__save-card" aria-label="保存位置"><div class="noosphere__rail-title">${railIcon("save")}<h3>保存位置</h3></div><label>思源文档<input data-field="targetDocumentId" class="b3-text-field" placeholder="输入思源文档 ID"></label><div class="noosphere__save-actions"><button data-action="save" class="b3-button noosphere__primary" type="button">保存文章</button></div><div data-role="saved" class="noosphere__saved" hidden><span>已保存</span><button data-action="openSaved" class="b3-button b3-button--outline" type="button">打开文档 ↗</button></div></section>
        </aside>
      </div>
      <section class="noosphere__history" data-role="historyPanel" aria-label="文章历史记录" hidden><div class="noosphere__history-heading"><div><h3>历史记录</h3><p>查看已抓取的文章，在文章页继续审阅或导入思源。</p></div><input data-role="historySearch" class="b3-text-field" type="search" aria-label="搜索历史文章" placeholder="搜索标题、链接或作者"></div><p class="noosphere__history-empty" data-role="historyEmpty">暂无历史文章，成功抓取后会自动保留。</p><div class="noosphere__history-list" data-role="historyList"></div></section>
    </main>
    <div class="noosphere__lightbox" data-role="imageLightbox" hidden><section role="dialog" aria-modal="true" aria-label="图片详情"><div class="noosphere__lightbox-heading"><h3 data-role="imageTitle"></h3><button data-action="closeImage" type="button" aria-label="关闭图片详情">×</button></div><img data-role="imageLarge" alt=""><p data-role="imageDescription"></p><a data-role="imageSource" target="_blank" rel="noopener noreferrer">打开图片来源 ↗</a><button data-action="toggleImage" class="b3-button b3-button--outline" type="button">移除图片</button></section></div>
  </div>`;
}
