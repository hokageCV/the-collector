import { getArticleByUrl, listArticles, deleteArticle } from '../db/db';
import { buildBundle } from '../export/build-bundle';
import type { ProgressMessage, SaveArticleResponse } from '../messages';

const saveButton = document.getElementById('save') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLParagraphElement | null;
const exportBtn = document.getElementById('export') as HTMLButtonElement | null;
const savedEl = document.getElementById('saved') as HTMLUListElement | null;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement | null;

function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

async function renderSaved(): Promise<void> {
  await syncSaveButton();
  if (!savedEl || !emptyEl || !exportBtn) return;
  const articles = await listArticles();
  exportBtn.disabled = articles.length === 0;
  emptyEl.hidden = articles.length > 0;
  savedEl.innerHTML = '';
  for (const a of articles) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'name';
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

exportBtn?.addEventListener('click', () => {
  buildBundle().catch((err) => setStatus(`Export failed: ${String(err)}`, 'error'));
});

void renderSaved();
