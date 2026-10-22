// @vitest-environment jsdom
/** 重现 API 更新锁定文档后，子节点 contenteditable 被思源重设为 true 的问题。 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CategoryIndexReadonly } from '../src/siyuan/index-readonly';

let guard: CategoryIndexReadonly;
beforeEach(() => {
  document.body.innerHTML = '<div class="protyle-wysiwyg" contenteditable="false" custom-sy-readonly="true" custom-zl-index-enabled="true"><div custom-zl-index="true"><div contenteditable="true"><span data-type="block-ref">目录</span></div></div></div>';
  guard = new CategoryIndexReadonly(document); guard.start();
});
afterEach(() => { guard.stop(); document.body.replaceChildren(); });

it('keeps new index blocks read-only after a live API replacement', async () => {
  const index = document.querySelector('[custom-zl-index]')!;
  index.innerHTML = '<div contenteditable="true">新文章</div>';
  await Promise.resolve();
  expect(index.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('false');
});
it('prevents destructive input while retaining copy and navigation', () => {
  const ref = document.querySelector('span')!;
  for (const type of ['beforeinput', 'cut', 'paste', 'drop']) {
    expect(ref.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))).toBe(false);
  }
  for (const key of ['Backspace', 'Delete', 'Enter', 'a']) {
    expect(ref.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))).toBe(false);
  }
  for (const key of ['c', 'ArrowDown']) {
    expect(ref.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: key === 'c', bubbles: true, cancelable: true }))).toBe(true);
  }
  expect(ref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true);
});
it('respects explicit native unlock and leaves articles editable', async () => {
  const editor = document.querySelector('.protyle-wysiwyg')!;
  editor.setAttribute('custom-sy-readonly', 'false');
  editor.querySelector('[contenteditable]')!.setAttribute('contenteditable', 'true');
  const article = document.createElement('div');
  article.className = 'protyle-wysiwyg'; article.contentEditable = 'true';
  document.body.append(article);
  await Promise.resolve();
  expect(editor.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('true');
  expect(editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))).toBe(true);
  expect(article.contentEditable).toBe('true');
});
it('removes protection listeners when disabled', () => {
  guard.stop();
  expect(document.querySelector('span')!.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }))).toBe(true);
});
