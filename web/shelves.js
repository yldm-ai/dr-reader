import { $, call, escape, bookUrl } from './bridge.js';
import { hydrate, icon } from './icons.ts';

// Books in the private shelf are hidden from every other library view.
export const PRIVATE_SHELF = 'private';
const privateShelf = () => ({ id: PRIVATE_SHELF, name: '隐私书架', bookIds: [] });

export class Shelves {
  items = [];
  selected = null;
  editing = null;

  hiddenIds() {
    return new Set(this.items.find(shelf => shelf.id === PRIVATE_SHELF)?.bookIds ?? []);
  }

  isPrivate(shelf) {
    return shelf?.id === PRIVATE_SHELF;
  }

  constructor(books, refresh) {
    this.books = books;
    this.refresh = refresh;
    $('shelves-back').onclick = () => {
      this.selected = null;
      $('library-search').value = '';
      refresh();
    };
    $('shelf-edit').onclick = () => this.edit(this.selected);
    $('shelf-cancel').onclick = () => $('shelf-dialog').close();
    $('shelf-form').onsubmit = event => this.save(event);
    $('shelf-books').onchange = () => this.coverOptions();
    $('shelf-cover-source').onchange = () => {
      const value = $('shelf-cover-source').value;
      this.cover = value === 'upload' ? { image: this.uploadedImage } : value ? { bookId: value } : null;
      this.preview();
    };
    $('shelf-name').oninput = () => this.preview();
    $('shelf-cover-upload').onclick = () => $('shelf-cover-file').click();
    $('shelf-cover-file').onchange = () => this.upload();
  }

  coverMarkup(shelf) {
    const book = this.books().find(book => book.id === shelf.cover?.bookId && shelf.bookIds.includes(book.id));
    const src = shelf.cover?.image || (book?.cover ? bookUrl(book, book.cover) : '');
    if (src) return `<img class="cover-image" src="${escape(src)}" alt="${escape(shelf.name)}封面">`;
    // Without a chosen cover the private shelf shows a mask rather than its name.
    if (this.isPrivate(shelf)) return `<div class="cover-fallback cover-image private-cover" role="img" aria-label="隐私书架封面">${icon('private-shelf')}</div>`;
    return `<div class="cover-fallback cover-image">${escape(shelf.name || '书架')}</div>`;
  }

  selectedBooks() {
    return [...$('shelf-books').querySelectorAll('input:checked')].map(input => input.value);
  }

  preview() {
    $('shelf-cover-preview').innerHTML = this.coverMarkup({ id: this.editing?.id, name: $('shelf-name').value, bookIds: this.selectedBooks(), cover: this.cover });
  }

  coverOptions() {
    const books = this.books().filter(book => this.selectedBooks().includes(book.id) && book.cover);
    if (this.cover?.bookId && !books.some(book => book.id === this.cover.bookId)) this.cover = null;
    $('shelf-cover-source').innerHTML = '<option value="">默认封面</option>' +
      books.map(book => `<option value="${escape(book.id)}">${escape(book.title)}</option>`).join('') +
      (this.uploadedImage ? '<option value="upload">本地上传的图片</option>' : '');
    $('shelf-cover-source').value = this.cover?.image ? 'upload' : this.cover?.bookId || '';
    this.preview();
  }

  async upload() {
    const file = $('shelf-cover-file').files[0];
    if (!file) return;
    const version = this.editVersion;
    $('shelf-error').textContent = '';
    $('shelf-save').disabled = true;
    try {
      if (file.size > 20 * 1024 * 1024) throw Error('请选择小于 20 MB 的图片。');
      const bitmap = await createImageBitmap(file);
      if (version !== this.editVersion || !$('shelf-dialog').open) { bitmap.close(); return; }
      const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      this.uploadedImage = canvas.toDataURL('image/webp', .85);
      this.cover = { image: this.uploadedImage };
      this.coverOptions();
    } catch (error) {
      if (version !== this.editVersion) return;
      $('shelf-error').textContent = `无法读取图片：${error.message}`;
    } finally {
      if (version === this.editVersion) {
        $('shelf-save').disabled = false;
        $('shelf-cover-file').value = '';
      }
    }
  }

  render(query) {
    const visible = this.items.filter(shelf => shelf.name.toLocaleLowerCase().includes(query));
    $('heading-count').textContent = visible.length;
    const hidden = this.hiddenIds();
    const cards = visible.map(shelf => {
      const card = document.createElement('button');
      card.className = 'shelf-card';
      const count = this.books().filter(book => shelf.bookIds.includes(book.id) && (this.isPrivate(shelf) || !hidden.has(book.id))).length;
      card.innerHTML = `<div class="cover-wrap">${this.coverMarkup(shelf)}</div><strong>${escape(shelf.name)}</strong><small>${count} 本图书${this.isPrivate(shelf) ? ' · 不在其他位置显示' : ''}</small>`;
      card.onclick = () => {
        this.selected = shelf;
        $('library-search').value = '';
        this.refresh();
      };
      return card;
    });
    const add = document.createElement('button');
    add.className = 'shelf-card shelf-add';
    add.id = 'shelf-add';
    add.innerHTML = '<div class="cover-wrap"><span data-icon="plus"></span></div><strong>添加新书架</strong><small>为喜欢的书留一个位置</small>';
    add.onclick = () => this.edit();
    $('shelf-grid').replaceChildren(...cards, add);
    hydrate();
  }

  async addBook(bookId, shelfId) {
    // Hiding also works against a store saved before the private shelf existed.
    const items = shelfId === PRIVATE_SHELF && !this.items.some(this.isPrivate) ? [privateShelf(), ...this.items] : this.items;
    const shelf = items.find(item => item.id === shelfId);
    if (!shelf) throw Error('这个分类书架已不存在');
    if (shelf.bookIds.includes(bookId)) return;
    await this.store(items.map(item => item.id === shelfId ? { ...item, bookIds: [...item.bookIds, bookId] } : item));
  }

  async removeBook(bookId, shelfId) {
    await this.store(this.items.map(item => item.id === shelfId ? { ...item, bookIds: item.bookIds.filter(id => id !== bookId) } : item));
  }

  async store(next) {
    this.items = await call('shelves.save', { shelves: next });
    if (this.selected) this.selected = this.items.find(item => item.id === this.selected.id) || null;
    this.refresh();
  }

  edit(shelf = null, bookId = null) {
    this.editing = shelf;
    this.editVersion = (this.editVersion || 0) + 1;
    $('shelf-save').disabled = false;
    this.cover = shelf?.cover || null;
    this.uploadedImage = this.cover?.image || '';
    $('shelf-cover-file').value = '';
    $('shelf-dialog-title').textContent = shelf ? '编辑书架' : '添加书架';
    $('shelf-name').value = shelf?.name || '';
    $('shelf-name').readOnly = this.isPrivate(shelf);
    $('shelf-error').textContent = '';
    // Other shelves never list hidden books; only the private shelf manages them.
    const hidden = this.hiddenIds();
    const listed = this.isPrivate(shelf) ? this.books() : this.books().filter(book => !hidden.has(book.id) || book.id === bookId);
    $('shelf-books').innerHTML = listed.map(book =>
      `<label><input type="checkbox" value="${escape(book.id)}" ${(shelf?.bookIds.includes(book.id) || book.id === bookId) ? 'checked' : ''}><span>${escape(book.title)}<small>${escape(book.author)}</small></span></label>`
    ).join('') || '<p>书库还没有图书，可以先创建空书架。</p>';
    this.coverOptions();
    $('shelf-dialog').showModal();
    $('shelf-name').focus();
  }

  async save(event) {
    event.preventDefault();
    const name = $('shelf-name').value.trim();
    if (!name) { $('shelf-error').textContent = '请输入书架名称。'; return; }
    if (this.items.some(item => item.id !== this.editing?.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      $('shelf-error').textContent = '已有同名书架，请换一个名称。'; return;
    }
    if (!this.isPrivate(this.editing) && name === privateShelf().name) {
      $('shelf-error').textContent = '“隐私书架”是保留名称，请换一个名称。'; return;
    }
    // Memberships of hidden books were not listed, so keep them as they were.
    const listed = new Set([...$('shelf-books').querySelectorAll('input')].map(input => input.value));
    const shelf = {
      id: this.editing?.id || crypto.randomUUID(), name,
      bookIds: [...(this.editing?.bookIds ?? []).filter(id => !listed.has(id)), ...this.selectedBooks()], cover: this.cover,
    };
    const next = this.editing ? this.items.map(item => item.id === shelf.id ? shelf : item) : [...this.items, shelf];
    $('shelf-save').disabled = true;
    $('shelf-cancel').disabled = true;
    const preventClose = event => event.preventDefault();
    $('shelf-dialog').addEventListener('cancel', preventClose);
    try {
      this.items = await call('shelves.save', { shelves: next });
      if (this.selected?.id === shelf.id) this.selected = this.items.find(item => item.id === shelf.id);
      if (!this.editing) $('library-search').value = '';
      $('shelf-dialog').close();
      this.refresh();
    } catch (error) {
      $('shelf-error').textContent = `保存失败：${error.message}`;
    } finally {
      $('shelf-save').disabled = false;
      $('shelf-cancel').disabled = false;
      $('shelf-dialog').removeEventListener('cancel', preventClose);
    }
  }
}
