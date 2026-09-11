export interface WidgetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetInfo {
  id: string;
  rect: WidgetRect;
  in_viewport: boolean;
}

export interface DetectResponse {
  scroll: { x: number; y: number };
  viewport: { w: number; h: number };
  dpr: number;
  widgets: WidgetInfo[];
}

export interface ExtractResponse {
  ok: boolean;
  reason?: 'unparseable';
  title: string;
  byline?: string | null;
  excerpt?: string | null;
  html?: string;
  url?: string;
  images?: string[];
}

export interface SaveArticleRequest {
  type: 'save';
  tabId: number;
  overwriteId?: string;
}

export interface SaveArticleResponse {
  ok: boolean;
  reason?: string;
  articleId?: string;
}

export interface ProgressMessage {
  type: 'collector-progress';
  text: string;
}

export interface ToastMessage {
  type: 'collector-toast';
  state: 'processing' | 'success' | 'error';
}

export type ExportMode = 'clear' | 'export';

export interface ExportConvertRequest {
  type: 'export-convert';
  /** chrome.downloads id started by the page (blob download survives page death). */
  downloadId: number;
  mode: ExportMode;
}

export interface ExportConvertResponse {
  ok: boolean;
  message?: string;
  outputPath?: string;
  cleared?: boolean;
  warning?: string;
}
