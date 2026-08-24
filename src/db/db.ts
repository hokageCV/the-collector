export interface ArticleRecord {
  id: string;
  url: string;
  title: string;
  byline: string | null;
  excerpt: string | null;
  html: string;
  slug: string;
  saved_at: number;
  order_index: number;
}

export interface ImageRecord {
  key: string;
  article_id: string;
  original_src: string;
  blob: Blob;
  mime_type: string;
}

const DB_NAME = 'the_collector';
const DB_VERSION = 1;
const ARTICLES = 'articles';
const IMAGES = 'images';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ARTICLES)) {
        const store = db.createObjectStore(ARTICLES, { keyPath: 'id' });
        store.createIndex('url', 'url', { unique: true });
        store.createIndex('order_index', 'order_index', { unique: false });
      }
      if (!db.objectStoreNames.contains(IMAGES)) {
        const store = db.createObjectStore(IMAGES, { keyPath: 'key' });
        store.createIndex('article_id', 'article_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function runTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDB();
  const tx = db.transaction(stores, mode);
  let result: T;
  const done = new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  result = await fn(tx);
  return done;
}

export function saveArticle(article: ArticleRecord): Promise<IDBValidKey> {
  return runTx([ARTICLES], 'readwrite', (tx) => {
    return reqToPromise(tx.objectStore(ARTICLES).put(article));
  });
}

export async function getArticleByUrl(url: string): Promise<ArticleRecord | undefined> {
  const db = await openDB();
  const tx = db.transaction(ARTICLES, 'readonly');
  const index = tx.objectStore(ARTICLES).index('url');
  const result = await reqToPromise(index.get(url));
  return result as ArticleRecord | undefined;
}

export async function listArticles(): Promise<ArticleRecord[]> {
  const db = await openDB();
  const tx = db.transaction(ARTICLES, 'readonly');
  const all = (await reqToPromise(tx.objectStore(ARTICLES).getAll())) as ArticleRecord[];
  return all.sort((a, b) => a.order_index - b.order_index);
}

export async function updateOrder(updates: { id: string; order_index: number }[]): Promise<void> {
  await runTx([ARTICLES], 'readwrite', (tx) => {
    const store = tx.objectStore(ARTICLES);
    for (const u of updates) {
      const existing = store.get(u.id);
      existing.onsuccess = () => {
        const rec = existing.result as ArticleRecord | undefined;
        if (rec) {
          rec.order_index = u.order_index;
          store.put(rec);
        }
      };
    }
  });
}

export async function deleteArticle(id: string): Promise<void> {
  await runTx([ARTICLES, IMAGES], 'readwrite', async (tx) => {
    tx.objectStore(ARTICLES).delete(id);
    const imgStore = tx.objectStore(IMAGES);
    const index = imgStore.index('article_id');
    const cursorReq = index.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

export async function clearArticles(): Promise<void> {
  await runTx([ARTICLES, IMAGES], 'readwrite', (tx) => {
    tx.objectStore(ARTICLES).clear();
    tx.objectStore(IMAGES).clear();
  });
}

export function saveImage(image: ImageRecord): Promise<IDBValidKey> {
  return runTx([IMAGES], 'readwrite', (tx) => {
    return reqToPromise(tx.objectStore(IMAGES).put(image));
  });
}

export async function getImagesForArticle(articleId: string): Promise<ImageRecord[]> {
  const db = await openDB();
  const tx = db.transaction(IMAGES, 'readonly');
  const index = tx.objectStore(IMAGES).index('article_id');
  return (await reqToPromise(index.getAll(IDBKeyRange.only(articleId)))) as ImageRecord[];
}

export async function getNextOrderIndex(): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(ARTICLES, 'readonly');
  const all = (await reqToPromise(tx.objectStore(ARTICLES).getAll())) as ArticleRecord[];
  if (all.length === 0) return 0;
  return Math.max(...all.map((a) => a.order_index)) + 1;
}
