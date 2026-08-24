import { clearArticles, listArticles, deleteArticle, updateOrder, type ArticleRecord } from '../db/db';
import { buildBundle } from '../export/build-bundle';

const listEl = document.getElementById('list') as HTMLUListElement;
const exportBtn = document.getElementById('export') as HTMLButtonElement;
const exportClearBtn = document.getElementById('export-clear') as HTMLButtonElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;

let dragId: string | null = null;

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
    exportBtn.disabled = true;
    exportClearBtn.disabled = true;
    return;
  }
  emptyEl.hidden = true;
  exportBtn.disabled = false;
  exportClearBtn.disabled = false;
  for (const a of articles) listEl.appendChild(renderItem(a));
}

exportBtn.addEventListener('click', () => {
  buildBundle().catch((err) => alert(`Export failed: ${String(err)}`));
});

exportClearBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportClearBtn.disabled = true;
  try {
    await buildBundle();
    await clearArticles();
    await render();
  } catch (err) {
    alert(`Export failed: ${String(err)}`);
    await render();
  }
});

void render();
