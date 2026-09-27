import Sortable from 'sortablejs';
import { getArticleByUrl, listArticles, deleteArticle, updateOrder } from '../db/db';
import { startBundleDownload } from '../export/build-bundle';
import type { ExportConvertResponse, ExportMode, ProgressMessage, SaveArticleResponse } from '../messages';
const saveButton = document.getElementById('save') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLParagraphElement | null;
const exportActionBtn = document.getElementById('export-action') as HTMLButtonElement | null;
const exportMenuBtn = document.getElementById('export-menu') as HTMLButtonElement | null;
const exportMenu = document.getElementById('export-menu-list') as HTMLDivElement | null;
const savedEl = document.getElementById('saved') as HTMLUListElement | null;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement | null;

type ExportAction = ExportMode;

let exportAction: ExportAction = 'clear';

function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

async function renderSaved(): Promise<void> {
  await syncSaveButton();
  if (!savedEl || !emptyEl || !exportActionBtn || !exportMenuBtn) return;
  const articles = await listArticles();
  exportActionBtn.disabled = articles.length === 0;
  exportMenuBtn.disabled = articles.length === 0;
  emptyEl.hidden = articles.length > 0;
  savedEl.innerHTML = '';
  for (const a of articles) {
    const li = document.createElement('li');
    li.dataset.id = a.id;

    const name = document.createElement('a');
    name.className = 'name';
    name.href = a.url;
    name.target = '_blank';
    name.rel = 'noopener noreferrer';
    name.textContent = a.title;
    name.title = a.url;
    // Suppress the browser's native link-drag so only our reorder drag runs.
    name.draggable = false;
    name.addEventListener('keydown', (event) => {
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        void moveArticle(a.id, event.key === 'ArrowUp' ? -1 : 1);
      }
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await deleteArticle(a.id);
      await renderSaved();
    });

    li.append(name, del);
    savedEl.appendChild(li);
  }
}

// Drag-to-reorder via SortableJS. forceFallback is essential: the default
// native HTML5 backend hands control to the OS, Chrome treats the popup as
// blurred, and dismisses it mid-drag. The fallback backend is synthetic
// (mouse/touch events), so the popup stays open, and it brings built-in
// auto-scroll near the list edges.
function currentDomOrder(): string[] {
  if (!savedEl) return [];
  return [...savedEl.querySelectorAll<HTMLLIElement>('li')]
    .map((li) => li.dataset.id ?? '')
    .filter((id) => id !== '');
}

// Persist a new order: renumber 0..n in the given sequence.
async function persistOrder(idsInOrder: string[]): Promise<void> {
  await updateOrder(idsInOrder.map((id, i) => ({ id, order_index: i })));
}

// After a real sort, swallow the click that mouseup would otherwise fire
// (e.g. releasing over the title link must not open it). Time-bounded so a
// stray armed listener can never eat a later legitimate click.
function suppressNextClick(): void {
  if (!savedEl) return;
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.clearTimeout(timer);
  };
  const timer = window.setTimeout(() => {
    savedEl?.removeEventListener('click', stop, true);
  }, 300);
  savedEl.addEventListener('click', stop, { capture: true, once: true });
}

if (savedEl) {
  Sortable.create(savedEl, {
    animation: 150,
    forceFallback: true,
    fallbackClass: 'sort-fallback',
    ghostClass: 'sort-ghost',
    chosenClass: 'sort-chosen',
    // Presses starting on the delete button are clicks, never drags.
    filter: '.del',
    preventOnFilter: true,
    // Hold-to-drag on touch so the list still scrolls by swipe.
    delay: 120,
    delayOnTouchOnly: true,
    scrollSensitivity: 28,
    scrollSpeed: 6,
    bubbleScroll: true,
    onStart: () => document.body.classList.add('reordering'),
    onEnd: (evt) => {
      document.body.classList.remove('reordering');
      if (evt.oldIndex === evt.newIndex) return;
      suppressNextClick();
      // Sortable already reordered the DOM; just persist (no re-render flicker).
      void persistOrder(currentDomOrder());
    },
  });
}

async function moveArticle(id: string, dir: -1 | 1): Promise<void> {
  const articles = await listArticles();
  const from = articles.findIndex((a) => a.id === id);
  const to = from + dir;
  if (from === -1 || to < 0 || to >= articles.length) return;
  const [moved] = articles.splice(from, 1);
  articles.splice(to, 0, moved!);
  await persistOrder(articles.map((a) => a.id));
  await renderSaved();
  savedEl?.querySelector<HTMLAnchorElement>(`li[data-id="${CSS.escape(id)}"] .name`)?.focus();
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

// The save button is disabled while the active tab's URL is already saved.
async function syncSaveButton(): Promise<void> {
  if (!saveButton) return;
  const tab = await getActiveTab();
  const existing = tab?.url ? await getArticleByUrl(tab.url) : undefined;
  saveButton.disabled = existing !== undefined;
}

function saveToBackground(tabId: number): Promise<SaveArticleResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'save', tabId }, (resp: SaveArticleResponse) => {
      resolve(resp ?? { ok: false, reason: chrome.runtime.lastError?.message ?? 'no response' });
    });
  });
}

// Background reports capture progress; surface it in the status line.
chrome.runtime.onMessage.addListener((msg: ProgressMessage) => {
  if (msg && msg.type === 'collector-progress') {
    setStatus(msg.text, 'info');
  }
});

async function onSave(): Promise<void> {
  if (!saveButton) return;
  saveButton.disabled = true;
  setStatus('Extracting…');

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setStatus('No active tab.', 'error');
    saveButton.disabled = false;
    return;
  }

  const res = await saveToBackground(tab.id);
  if (res.ok) {
    setStatus(`Saved: ${tab.title ?? tab.url}`, 'success');
    await renderSaved();
  } else {
    setStatus(`Save failed: ${res.reason ?? 'unknown'}`, 'error');
    saveButton.disabled = false;
  }
}

saveButton?.addEventListener('click', () => {
  onSave().catch((err) => setStatus(`Error: ${String(err)}`, 'error'));
});

function setExportAction(action: ExportAction): void {
  exportAction = action;
  if (exportActionBtn) exportActionBtn.textContent = action === 'clear' ? 'Export & clear' : 'Export';
  exportMenu?.querySelectorAll<HTMLButtonElement>('[data-export-action]').forEach((item) => {
    item.setAttribute('aria-checked', String(item.dataset.exportAction === action));
  });
  void chrome.storage.local.set({ exportAction: action });
}

function closeExportMenu(): void {
  if (!exportMenu || !exportMenuBtn) return;
  exportMenu.hidden = true;
  exportMenuBtn.setAttribute('aria-expanded', 'false');
}

function exportToBackground(downloadId: number, mode: ExportMode): Promise<ExportConvertResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'export-convert', downloadId, mode }, (resp: ExportConvertResponse) => {
      resolve(resp ?? { ok: false, message: chrome.runtime.lastError?.message ?? 'no response' });
    });
  });
}

async function runExport(): Promise<void> {
  if (!exportActionBtn || !exportMenuBtn) return;
  exportActionBtn.disabled = true;
  exportMenuBtn.disabled = true;
  // Only the download start needs this page; the worker owns everything after,
  // so closing this popup mid-export is safe.
  setStatus('Starting export…');
  let revokeUrl: (() => void) | null = null;
  try {
    const started = await startBundleDownload();
    revokeUrl = started.revokeUrl;
    const res = await exportToBackground(started.downloadId, exportAction);
    if (res.ok) {
      const name = res.outputPath?.split('/').pop() ?? res.outputPath ?? '';
      const suffix = res.warning ? ` ${res.warning}` : '';
      setStatus(
        res.cleared ? `Ready: ${name} (collection cleared).${suffix}` : `Ready: ${name}${suffix}`,
        'success',
      );
    } else {
      setStatus(`Export failed: ${res.message ?? 'unknown error'}`, 'error');
    }
  } catch (err) {
    setStatus(`Export failed: ${String(err)}`, 'error');
  } finally {
    revokeUrl?.();
    await renderSaved();
  }
}

exportActionBtn?.addEventListener('click', () => void runExport());

exportMenuBtn?.addEventListener('click', () => {
  if (!exportMenu || !exportMenuBtn) return;
  const willOpen = exportMenu.hidden;
  exportMenu.hidden = !willOpen;
  exportMenuBtn.setAttribute('aria-expanded', String(willOpen));
});

exportMenu?.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-export-action]');
  if (!target) return;
  setExportAction(target.dataset.exportAction as ExportAction);
  closeExportMenu();
});

document.addEventListener('click', (event) => {
  const target = event.target as Node;
  if (exportMenu && !exportMenu.hidden && !exportMenu.parentElement?.contains(target)) closeExportMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeExportMenu();
});

void chrome.storage.local.get('exportAction').then(({ exportAction: savedAction }) => {
  if (savedAction === 'clear' || savedAction === 'export') setExportAction(savedAction);
});

void renderSaved();
