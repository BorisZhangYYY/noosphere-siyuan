/** 思源实时替换块时会重新生成可编辑子节点；受管索引页沿用文档锁补齐保护。 */
const EDITOR = '.protyle-wysiwyg';
const MANAGED = '[custom-zl-index-enabled="true"], [custom-zl-index]';

export class CategoryIndexReadonly {
  private observer?: MutationObserver;
  constructor(private readonly document: Document) {}

  private locked(editor: Element | null): editor is HTMLElement {
    return !!editor && editor.getAttribute('custom-sy-readonly') === 'true'
      && (editor.matches(MANAGED) || !!editor.querySelector('[custom-zl-index]'));
  }

  /** 只恢复锁定页的编辑属性；原生解锁流程自行恢复编辑，不改用户的文档属性。 */
  private enforce = (): void => {
    for (const editor of Array.from(this.document.querySelectorAll(EDITOR))) {
      if (!this.locked(editor)) continue;
      if (editor.getAttribute('contenteditable') === 'true') editor.setAttribute('contenteditable', 'false');
      editor.querySelectorAll('[contenteditable="true"]').forEach(child => child.setAttribute('contenteditable', 'false'));
    }
  };

  private editorFor(event: Event): Element | null {
    const target = event.target as Node | null;
    const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
    const direct = element?.closest(EDITOR);
    if (direct) return direct;
    // 锁定文字仍可选择；键盘焦点可能落在 body 上，编辑命令要按选择区域判定。
    if (target !== this.document.body && target !== this.document.documentElement && target !== this.document) return null;
    return this.document.getSelection()?.anchorNode?.parentElement?.closest(EDITOR) || null;
  }

  private preventEdit = (event: Event): void => {
    if (!this.locked(this.editorFor(event))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private onKeydown = (event: KeyboardEvent): void => {
    const modifier = event.metaKey || event.ctrlKey;
    const edit = modifier ? ['x', 'v', 'z', 'y'].includes(event.key.toLowerCase())
      : event.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(event.key);
    if (edit) this.preventEdit(event);
  };

  start(): void {
    if (this.observer) return;
    this.enforce();
    this.observer = new MutationObserver(this.enforce);
    this.observer.observe(this.document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['contenteditable', 'custom-sy-readonly', 'custom-zl-index-enabled', 'custom-zl-index'] });
    for (const type of ['beforeinput', 'cut', 'paste', 'drop']) this.document.addEventListener(type, this.preventEdit, true);
    this.document.addEventListener('keydown', this.onKeydown, true);
  }
  stop(): void {
    this.observer?.disconnect(); this.observer = undefined;
    for (const type of ['beforeinput', 'cut', 'paste', 'drop']) this.document.removeEventListener(type, this.preventEdit, true);
    this.document.removeEventListener('keydown', this.onKeydown, true);
  }
}
