import { listArticles, deleteArticle, updateOrder, type ArticleRecord } from '../db/db';
import { startBundleDownload } from '../export/build-bundle';
import type { ExportConvertResponse, ExportMode, ProgressMessage } from '../messages';

const listEl = document.getElementById('list') as HTMLUListElement;
const exportActionBtn = document.getElementById('export-action') as HTMLButtonElement;
const exportMenuBtn = document.getElementById('export-menu') as HTMLButtonElement;
const exportMenu = document.getElementById('export-menu-list') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement | null;

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

// The service worker reports pipeline progress; surface it in the status line.
chrome.runtime.onMessage.addListener((msg: ProgressMessage) => {
  if (msg && msg.type === 'collector-progress') {
    setStatus(msg.text);
  }
});

function exportToBackground(downloadId: number, mode: ExportMode): Promise<ExportConvertResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'export-convert', downloadId, mode }, (resp: ExportConvertResponse) => {
      resolve(resp ?? { ok: false, message: chrome.runtime.lastError?.message ?? 'no response' });
    });
  });
}

let dragId: string | null = null;
type ExportAction = ExportMode;
let exportAction: ExportAction = 'clear';

function renderItem(a: ArticleRecord): HTMLLIElement {
  const li = document.createElement('li');
  li.draggable = true;
  li.dataset.id = a.id;

  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.textContent = '⠿';

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = a.title;
  const sub = document.createElement('div');
  sub.className = 'sub';
  const link = document.createElement('a');
  link.href = a.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = a.url;
  sub.append(link, document.createTextNode(` · ${new Date(a.saved_at).toLocaleDateString()}`));
  info.append(title, sub);

  const del = document.createElement('button');
  del.className = 'del';
  del.title = 'Delete';
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    if (confirm(`Delete "${a.title}"? This also removes its images.`)) {
      await deleteArticle(a.id);
      await render();
    }
  });

  li.append(handle, info, del);

  li.addEventListener('dragstart', (e) => {
    dragId = a.id;
    li.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  li.addEventListener('dragenter', () => li.classList.add('drop-target'));
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('drop-target');
    if (dragId && dragId !== a.id) onDrop(dragId, e.clientY, li);
  });

  return li;
}

function onDrop(sourceId: string, clientY: number, targetLi: HTMLLIElement): void {
  const dragged = listEl.querySelector<HTMLLIElement>(`li[data-id="${sourceId}"]`);
  if (!dragged) return;
  const rect = targetLi.getBoundingClientRect();
  const after = clientY > rect.top + rect.height / 2;
  if (after) targetLi.after(dragged);
  else targetLi.before(dragged);
  void persistOrder();
}

async function persistOrder(): Promise<void> {
  const ids = Array.from(listEl.querySelectorAll('li')).map((li) => li.dataset.id!);
  await updateOrder(ids.map((id, i) => ({ id, order_index: i })));
}

async function render(): Promise<void> {
  const articles = await listArticles();
  listEl.innerHTML = '';
  if (articles.length === 0) {
    emptyEl.hidden = false;
    exportActionBtn.disabled = true;
    exportMenuBtn.disabled = true;
    return;
  }
  emptyEl.hidden = true;
  exportActionBtn.disabled = false;
  exportMenuBtn.disabled = false;
  for (const a of articles) listEl.appendChild(renderItem(a));
}

function setExportAction(action: ExportAction): void {
  exportAction = action;
  exportActionBtn.textContent = action === 'clear' ? 'Export & clear' : 'Export';
  exportMenu.querySelectorAll<HTMLButtonElement>('[data-export-action]').forEach((item) => {
    item.setAttribute('aria-checked', String(item.dataset.exportAction === action));
  });
  void chrome.storage.local.set({ exportAction: action });
}

function closeExportMenu(): void {
  exportMenu.hidden = true;
  exportMenuBtn.setAttribute('aria-expanded', 'false');
}

async function runExport(): Promise<void> {
  exportActionBtn.disabled = true;
  exportMenuBtn.disabled = true;
  // Only the download start needs this page; the worker owns everything after.
  setStatus('Starting export…');
  let revokeUrl: (() => void) | null = null;
  try {
    const started = await startBundleDownload();
    revokeUrl = started.revokeUrl;
    const res = await exportToBackground(started.downloadId, exportAction);
    if (res.ok) {
      const name = res.outputPath?.split('/').pop() ?? res.outputPath ?? '';
      const suffix = res.warning ? ` ${res.warning}` : '';
      // The worker clears the collection only after successful conversion.
      setStatus(res.cleared ? `Ready: ${name} (collection cleared).${suffix}` : `Ready: ${name}${suffix}`);
    } else {
      const message = `Export failed: ${res.message ?? 'unknown error'}`;
      setStatus(message);
      alert(message);
    }
  } catch (err) {
    const message = `Export failed: ${String(err)}`;
    setStatus(message);
    alert(message);
  } finally {
    revokeUrl?.();
    await render();
  }
}

exportActionBtn.addEventListener('click', () => void runExport());

exportMenuBtn.addEventListener('click', () => {
  const willOpen = exportMenu.hidden;
  exportMenu.hidden = !willOpen;
  exportMenuBtn.setAttribute('aria-expanded', String(willOpen));
});

exportMenu.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-export-action]');
  if (!target) return;
  setExportAction(target.dataset.exportAction as ExportAction);
  closeExportMenu();
});

document.addEventListener('click', (event) => {
  if (!exportMenu.hidden && !exportMenu.parentElement?.contains(event.target as Node)) closeExportMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeExportMenu();
});

void chrome.storage.local.get('exportAction').then(({ exportAction: savedAction }) => {
  if (savedAction === 'clear' || savedAction === 'export') setExportAction(savedAction);
});

void render();
