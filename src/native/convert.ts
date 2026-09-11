export const NATIVE_HOST_NAME = 'com.thecollector.converter';

export interface ConvertSuccess {
  ok: true;
  outputPath: string;
  warning?: string;
}

export type ConvertFailureReason =
  | 'host-missing'
  | 'calibre-missing'
  | 'convert-failed';

export interface ConvertFailure {
  ok: false;
  reason: ConvertFailureReason;
  message: string;
}

export type ConvertResult = ConvertSuccess | ConvertFailure;

interface HostResponse {
  success?: boolean;
  outputPath?: string;
  warning?: string;
  error?: string;
}

function classifyError(message: string): ConvertFailureReason {
  const m = message.toLowerCase();
  if (
    m.includes('specified native messaging host not found') ||
    m.includes('native messaging host') && m.includes('not found') ||
    m.includes('not installed') ||
    m.includes('no such host')
  ) {
    return 'host-missing';
  }
  if (m.includes('calibre') || m.includes('ebook-convert')) {
    return 'calibre-missing';
  }
  return 'convert-failed';
}

const HOST_MISSING_HINT =
  'Native host not installed. Run native-host/install.sh --extension-id <ID> (see native-host/README.md). The ZIP is kept in Downloads.';

/**
 * Auto-convert a downloaded ZIP via the native host.
 * Called directly from popup/options pages (extension context).
 */
export function convertViaNativeHost(zipPath: string): Promise<ConvertResult> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST_NAME,
        { action: 'convert', zipPath },
        (resp: HostResponse | undefined) => {
          const lastError = chrome.runtime.lastError?.message;
          if (lastError) {
            const reason = classifyError(lastError);
            resolve({
              ok: false,
              reason,
              message: reason === 'host-missing' ? HOST_MISSING_HINT : lastError,
            });
            return;
          }
          if (!resp) {
            resolve({ ok: false, reason: 'host-missing', message: HOST_MISSING_HINT });
            return;
          }
          if (resp.success && resp.outputPath) {
            resolve({ ok: true, outputPath: resp.outputPath, warning: resp.warning });
            return;
          }
          const message = resp.error ?? 'Conversion failed.';
          resolve({ ok: false, reason: classifyError(message), message });
        },
      );
    } catch (err) {
      resolve({ ok: false, reason: 'convert-failed', message: String(err) });
    }
  });
}
