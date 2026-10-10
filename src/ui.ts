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
import { PROVIDER_ORDER, PROVIDER_PRESETS } from "./review/providers";

const providerOptions = PROVIDER_ORDER.map(id => [id, PROVIDER_PRESETS[id].label] as const);

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
        <div class="noosphere__provider-top">${dropdown("modelProvider", "模型供应商", providerOptions)}<p data-role="providerDescription"></p></div>
        <div class="noosphere__provider-fields">
          <label>API Key${secret("modelKey")}</label>
          <div class="noosphere__model-row"><label>模型<input data-field="modelName" class="b3-text-field" placeholder="输入模型 ID，或获取可用模型"></label><button data-action="listModels" class="b3-button b3-button--outline" type="button">获取模型</button></div>
          <div class="noosphere__model-results" data-role="modelResults" hidden><span data-role="modelResultsLabel"></span><input data-role="modelSearch" class="b3-text-field" type="search" aria-label="筛选模型" placeholder="筛选模型名称"><div data-role="modelOptions" class="noosphere__model-options"></div></div>
          <label class="noosphere__vision-option"><input data-field="modelVisionCapable" type="checkbox"> 这个模型支持识图</label>
          <details class="noosphere__advanced" data-role="providerAdvanced"><summary>接口设置</summary>${dropdown("modelFormat", "接口协议", formatOptions)}<label>API 地址<input data-field="modelBaseUrl" class="b3-text-field" type="url" placeholder="https://api.example.com/v1"></label><p>已为供应商填好常用地址；只有使用特殊网关时才需要修改。</p></details>
        </div>
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
      <section class="noosphere__capture"><div><span class="noosphere__eyebrow">采集工作台</span><h2>从网页提取内容</h2></div><div class="noosphere__url-row"><input data-field="url" class="b3-text-field" type="url" inputmode="url" aria-label="文章链接" placeholder="粘贴文章链接 https://…"><button data-action="scrape" class="b3-button noosphere__primary" type="button">抓取文章</button></div></section>
      <div class="noosphere__work-grid">
        <section class="noosphere__panel noosphere__review-panel"><div class="noosphere__panel-title"><h3>文章正文</h3><span data-role="articleMeta"></span></div>
          <div class="noosphere__review-actions">${dropdown("workPerspective", "审阅视角", perspectiveOptions)}<button data-action="review" class="b3-button b3-button--outline" type="button">AI 审阅</button></div>
          <div data-role="empty" class="noosphere__empty"><strong>等待抓取</strong><span>文章正文会出现在这里</span></div>
          <textarea data-field="markdown" class="b3-text-field noosphere__editor" aria-label="文章正文预览与编辑" placeholder="抓取后可在此编辑正文" hidden></textarea>
          <section class="noosphere__image-decisions" data-role="imageDecisions" hidden><div class="noosphere__image-decisions-head"><strong>图片审阅建议</strong><span data-role="imageDecisionCount"></span></div><p>AI 根据审阅后的文章判断图片。建议移除的图片已在正文预览中隐藏；可在这里恢复或调整，保存时以当前预览为准。</p><div data-role="imageDecisionList"></div></section>
        </section>
        <aside class="noosphere__side">
          <section class="noosphere__panel"><div class="noosphere__panel-title"><h3>进度</h3></div><ol class="noosphere__progress"><li data-stage="scrape"><b>1</b><span>抓取文章</span></li><li data-stage="review"><b>2</b><span>检查与审阅</span></li><li data-stage="save"><b>3</b><span>保存到思源</span></li></ol><p class="noosphere__status" data-role="status" data-tone="info" role="status" aria-live="polite"><span data-role="statusText">粘贴链接后开始抓取。</span></p></section>
          <section class="noosphere__panel"><div class="noosphere__panel-title"><h3>保存位置</h3></div><label>目标文档 ID<input data-field="targetDocumentId" class="b3-text-field" placeholder="选择当前文档或输入 ID"></label><button data-action="current" class="b3-button b3-button--outline noosphere__current" type="button">使用当前文档</button><button data-action="save" class="b3-button noosphere__primary noosphere__save" type="button">保存文章</button><div data-role="saved" class="noosphere__saved" hidden><span>已保存到思源</span><button data-action="openSaved" class="b3-button b3-button--outline" type="button">打开文档 ↗</button></div></section>
        </aside>
      </div>
    </main>
  </div>`;
}
