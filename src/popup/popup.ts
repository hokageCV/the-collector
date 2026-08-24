import { clearArticles, getArticleByUrl, listArticles, deleteArticle } from '../db/db';
import { buildBundle } from '../export/build-bundle';
import type { ProgressMessage, SaveArticleResponse } from '../messages';

const saveButton = document.getElementById('save') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLParagraphElement | null;
const exportActionBtn = document.getElementById('export-action') as HTMLButtonElement | null;
const exportMenuBtn = document.getElementById('export-menu') as HTMLButtonElement | null;
const exportMenu = document.getElementById('export-menu-list') as HTMLDivElement | null;
const savedEl = document.getElementById('saved') as HTMLUListElement | null;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement | null;

type ExportAction = 'clear' | 'export';

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

    const name = document.createElement('a');
    name.className = 'name';
    name.href = a.url;
    name.target = '_blank';
    name.rel = 'noopener noreferrer';
    name.textContent = a.title;
    name.title = a.url;

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

async function runExport(): Promise<void> {
  if (!exportActionBtn || !exportMenuBtn) return;
  exportActionBtn.disabled = true;
  exportMenuBtn.disabled = true;
  try {
    await buildBundle();
    if (exportAction === 'clear') {
      await clearArticles();
      setStatus('Exported and cleared the collection.', 'success');
    } else {
      setStatus('Exported the collection.', 'success');
    }
    await renderSaved();
  } catch (err) {
    setStatus(`Export failed: ${String(err)}`, 'error');
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
