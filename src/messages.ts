export interface ExtractRequest {
  type: 'extract';
}

export interface ExtractResponse {
  ok: boolean;
  reason?: 'unparseable';
  title?: string;
  byline?: string | null;
  excerpt?: string | null;
  html?: string;
  url?: string;
  images?: string[];
}

export interface SaveArticleRequest {
  type: 'save';
  extract: ExtractResponse;
  overwriteId?: string;
}

export interface SaveArticleResponse {
  ok: boolean;
  reason?: string;
  articleId?: string;
}
