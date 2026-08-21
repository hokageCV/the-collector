import { getArticleByUrl } from '../db/db';
import type { ExtractResponse, SaveArticleResponse } from '../messages';

const saveButton = document.getElementById('save') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLParagraphElement | null;

function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function extractFromTab(tabId: number): Promise<ExtractResponse> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-script.js'],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__theCollectorExtract!(),
  });
  return results[0].result as ExtractResponse;
}

async function saveToBackground(
  extract: ExtractResponse,
  overwriteId?: string,
): Promise<SaveArticleResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'save', extract, overwriteId }, (resp: SaveArticleResponse) => {
      resolve(resp ?? { ok: false, reason: chrome.runtime.lastError?.message ?? 'no response' });
    });
  });
}

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

  let extract: ExtractResponse;
  try {
    extract = await extractFromTab(tab.id);
  } catch (err) {
    setStatus(`Extraction failed: ${String(err)}`, 'error');
    saveButton.disabled = false;
    return;
  }

  if (!extract.ok) {
    setStatus("Couldn't extract this page.", 'error');
    saveButton.disabled = false;
    return;
  }

  const existing = await getArticleByUrl(extract.url ?? '');
  if (existing) {
    const ok = confirm(`"${existing.title}" is already saved. Re-save (overwrite)?`);
    if (!ok) {
      setStatus('Already saved (left as-is).', 'info');
      saveButton.disabled = false;
      return;
    }
    const res = await saveToBackground(extract, existing.id);
    if (res.ok) setStatus(`Updated: ${extract.title}`, 'success');
    else setStatus(`Update failed: ${res.reason ?? 'unknown'}`, 'error');
    saveButton.disabled = false;
    return;
  }

  const res = await saveToBackground(extract);
  if (res.ok) setStatus(`Saved: ${extract.title}`, 'success');
  else setStatus(`Save failed: ${res.reason ?? 'unknown'}`, 'error');
  saveButton.disabled = false;
}

saveButton?.addEventListener('click', () => {
  onSave().catch((err) => setStatus(`Error: ${String(err)}`, 'error'));
});
