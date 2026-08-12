import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFString,
  PDFNumber,
  PDFRef,
} from 'pdf-lib';
import { createIcons, icons } from 'lucide';
import { showLoader, hideLoader, showAlert } from '../ui.js';
import {
  downloadFile,
  formatBytes,
  escapeHtml,
  truncateFilename,
} from '../utils/helpers.js';
import { loadPdfWithPasswordPrompt } from '../utils/password-prompt.js';
import { loadPdfDocument } from '../utils/load-pdf-document.js';
import { EditHyperlinksState, HyperlinkEntry, ZoomMode } from '@/types';

const pageState: EditHyperlinksState = {
  file: null,
  pdfDoc: null,
  links: [],
};

function lookupAsDict(
  pdfDoc: PDFDocument,
  ref: ReturnType<PDFDict['get']>
): PDFDict | undefined {
  if (!ref) return undefined;
  const result = pdfDoc.context.lookup(ref);
  return result instanceof PDFDict ? result : undefined;
}

function decodeMaybeString(value: unknown): string {
  if (!value) return '';
  const maybe = value as {
    decodeText?: () => string;
    asString?: () => string;
  };
  if (typeof maybe.decodeText === 'function') return maybe.decodeText();
  if (typeof maybe.asString === 'function') return maybe.asString();
  return '';
}

function scanHyperlinks(pdfDoc: PDFDocument): HyperlinkEntry[] {
  const pages = pdfDoc.getPages();
  const links: HyperlinkEntry[] = [];
  let id = 0;

  pages.forEach((page, pageIndex) => {
    const annotRefs = page.node.Annots()?.asArray() || [];

    for (const ref of annotRefs) {
      const annot = lookupAsDict(pdfDoc, ref);
      if (!annot) continue;

      const subtype = annot.get(PDFName.of('Subtype'))?.toString();
      if (subtype !== '/Link') continue;

      const actionRef = annot.get(PDFName.of('A'));
      const actionDict = lookupAsDict(pdfDoc, actionRef);
      const actionType = actionDict
        ? (actionDict.get(PDFName.of('S'))?.toString().slice(1) ?? null)
        : null;

      let url = '';
      let editable = false;

      if (actionType === 'URI' && actionDict) {
        url = decodeMaybeString(actionDict.get(PDFName.of('URI')));
        editable = true;
      } else if (actionType) {
        url = `(${actionType} link)`;
      } else if (annot.has(PDFName.of('Dest'))) {
        url = '(internal destination)';
      } else {
        continue;
      }

      links.push({
        id: id++,
        pageNumber: pageIndex + 1,
        actionType,
        url,
        originalUrl: url,
        actionDict: editable ? (actionDict as PDFDict) : null,
        editable,
      });
    }
  });

  return links;
}

function renderLinksList(): void {
  const listEl = document.getElementById('links-list');
  const noLinksEl = document.getElementById('no-links');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (pageState.links.length === 0) {
    noLinksEl?.classList.remove('hidden');
    listEl.classList.add('hidden');
    createIcons({ icons });
    return;
  }

  noLinksEl?.classList.add('hidden');
  listEl.classList.remove('hidden');

  for (const entry of pageState.links) {
    const row = document.createElement('div');
    row.className =
      'flex items-center gap-3 bg-gray-700 border border-gray-600 rounded-lg p-3';

    const pageBadge = document.createElement('span');
    pageBadge.className =
      'flex-shrink-0 text-xs font-semibold text-indigo-300 bg-indigo-900/50 px-2 py-1 rounded';
    pageBadge.textContent = `Page ${entry.pageNumber}`;

    row.appendChild(pageBadge);

    if (entry.editable) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = entry.url;
      input.className =
        'flex-1 min-w-0 bg-gray-800 border border-gray-600 text-white text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2';
      input.addEventListener('input', () => {
        entry.url = input.value;
      });
      row.appendChild(input);
    } else {
      const span = document.createElement('span');
      span.className = 'flex-1 min-w-0 truncate text-sm text-gray-400 italic';
      span.textContent = entry.url;
      row.appendChild(span);

      const badge = document.createElement('span');
      badge.className =
        'flex-shrink-0 text-xs font-semibold text-gray-400 bg-gray-900 px-2 py-1 rounded';
      badge.textContent = 'Not editable';
      row.appendChild(badge);
    }

    listEl.appendChild(row);
  }

  createIcons({ icons });
}

function replaceAll(): void {
  const findInput = document.getElementById(
    'find-input'
  ) as HTMLInputElement | null;
  const replaceInput = document.getElementById(
    'replace-input'
  ) as HTMLInputElement | null;
  const caseSensitiveCheckbox = document.getElementById(
    'case-sensitive-checkbox'
  ) as HTMLInputElement | null;

  const find = findInput?.value ?? '';
  const replacement = replaceInput?.value ?? '';
  const caseSensitive = caseSensitiveCheckbox?.checked ?? false;

  if (!find) {
    showAlert('Error', 'Enter text to find first.');
    return;
  }

  let changedCount = 0;

  for (const entry of pageState.links) {
    if (!entry.editable) continue;

    if (caseSensitive) {
      if (!entry.url.includes(find)) continue;
      entry.url = entry.url.split(find).join(replacement);
      changedCount++;
    } else {
      const lowerUrl = entry.url.toLowerCase();
      const lowerFind = find.toLowerCase();
      if (!lowerUrl.includes(lowerFind)) continue;

      let result = '';
      let cursor = 0;
      let searchIndex = lowerUrl.indexOf(lowerFind, cursor);
      while (searchIndex !== -1) {
        result += entry.url.slice(cursor, searchIndex) + replacement;
        cursor = searchIndex + find.length;
        searchIndex = lowerUrl.indexOf(lowerFind, cursor);
      }
      result += entry.url.slice(cursor);
      entry.url = result;
      changedCount++;
    }
  }

  renderLinksList();

  if (changedCount === 0) {
    showAlert('No Matches', `No hyperlinks contained "${escapeHtml(find)}".`);
  }
}

function buildDestinationArray(
  pdfDoc: PDFDocument,
  pageRef: PDFRef,
  zoomMode: ZoomMode
) {
  const percentages: Record<string, number> = {
    '50': 50,
    '75': 75,
    '100': 100,
    '125': 125,
    '150': 150,
    '200': 200,
  };

  if (zoomMode in percentages) {
    return pdfDoc.context.obj([
      pageRef,
      PDFName.of('XYZ'),
      null,
      null,
      PDFNumber.of(percentages[zoomMode] / 100),
    ]);
  }

  if (zoomMode === 'fit') {
    return pdfDoc.context.obj([pageRef, PDFName.of('Fit')]);
  }

  if (zoomMode === 'fith') {
    return pdfDoc.context.obj([pageRef, PDFName.of('FitH'), null]);
  }

  if (zoomMode === 'fitv') {
    return pdfDoc.context.obj([pageRef, PDFName.of('FitV'), null]);
  }

  return null;
}

function applyZoomSetting(pdfDoc: PDFDocument): void {
  const zoomSelect = document.getElementById(
    'zoom-select'
  ) as HTMLSelectElement | null;
  const zoomMode = (zoomSelect?.value ?? 'keep') as ZoomMode;

  if (zoomMode === 'keep') return;

  if (zoomMode === 'none') {
    pdfDoc.catalog.delete(PDFName.of('OpenAction'));
    return;
  }

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return;

  const pageRef = pages[0].ref;
  const destArray = buildDestinationArray(pdfDoc, pageRef, zoomMode);
  if (destArray) {
    pdfDoc.catalog.set(PDFName.of('OpenAction'), destArray);
  }
}

async function processAndDownload(): Promise<void> {
  if (!pageState.pdfDoc || !pageState.file) {
    showAlert('Error', 'Please upload a PDF file first.');
    return;
  }

  showLoader('Saving changes...');

  try {
    for (const entry of pageState.links) {
      if (
        entry.editable &&
        entry.actionDict &&
        entry.url !== entry.originalUrl
      ) {
        entry.actionDict.set(PDFName.of('URI'), PDFString.of(entry.url));
      }
    }

    applyZoomSetting(pageState.pdfDoc);

    const newPdfBytes = await pageState.pdfDoc.save();
    downloadFile(
      new Blob([new Uint8Array(newPdfBytes)], { type: 'application/pdf' }),
      pageState.file.name
    );

    showAlert(
      'Success',
      'Hyperlinks updated successfully!',
      'success',
      () => {
        resetState();
      }
    );
  } catch (e) {
    console.error(e);
    showAlert('Error', 'Could not update hyperlinks.');
  } finally {
    hideLoader();
  }
}

function updateFileDisplay(): void {
  const displayArea = document.getElementById('file-display-area');
  if (!displayArea || !pageState.file || !pageState.pdfDoc) return;

  const pageCount = pageState.pdfDoc.getPageCount();

  displayArea.innerHTML = `
    <div class="bg-gray-700 p-3 rounded-lg border border-gray-600 hover:border-indigo-500 transition-colors">
      <div class="flex items-center justify-between">
        <div class="flex-1 min-w-0">
          <p class="truncate font-medium text-white">${escapeHtml(truncateFilename(pageState.file.name))}</p>
          <p class="text-gray-400 text-sm">${formatBytes(pageState.file.size)} • ${pageCount} page${pageCount !== 1 ? 's' : ''} • ${pageState.links.length} link${pageState.links.length !== 1 ? 's' : ''} found</p>
        </div>
        <button id="remove-file" class="text-red-400 hover:text-red-300 p-2 flex-shrink-0 ml-2" title="Remove file">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
  `;

  createIcons({ icons });

  document
    .getElementById('remove-file')
    ?.addEventListener('click', () => resetState());
}

function resetState(): void {
  pageState.pdfDoc = null;
  pageState.file = null;
  pageState.links = [];

  const displayArea = document.getElementById('file-display-area');
  if (displayArea) displayArea.innerHTML = '';

  document.getElementById('tool-options')?.classList.add('hidden');

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (fileInput) fileInput.value = '';

  const findInput = document.getElementById(
    'find-input'
  ) as HTMLInputElement | null;
  const replaceInput = document.getElementById(
    'replace-input'
  ) as HTMLInputElement | null;
  const zoomSelect = document.getElementById(
    'zoom-select'
  ) as HTMLSelectElement | null;
  if (findInput) findInput.value = '';
  if (replaceInput) replaceInput.value = '';
  if (zoomSelect) zoomSelect.value = 'keep';

  renderLinksList();
}

async function handleFileUpload(file: File): Promise<void> {
  if (!file || file.type !== 'application/pdf') {
    showAlert('Error', 'Please upload a valid PDF file.');
    return;
  }

  try {
    const result = await loadPdfWithPasswordPrompt(file);
    if (!result) return;
    showLoader('Scanning for hyperlinks...');
    result.pdf.destroy();
    pageState.pdfDoc = await loadPdfDocument(result.bytes);
    pageState.file = result.file;
    pageState.links = scanHyperlinks(pageState.pdfDoc);

    updateFileDisplay();
    renderLinksList();
    document.getElementById('tool-options')?.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    showAlert('Error', 'Failed to load PDF file.');
  } finally {
    hideLoader();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const processBtn = document.getElementById('process-btn');
  const backBtn = document.getElementById('back-to-tools');
  const replaceAllBtn = document.getElementById('replace-all-btn');

  fileInput?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleFileUpload(file);
  });

  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-indigo-500');
  });

  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-indigo-500');
  });

  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-indigo-500');
    const file = e.dataTransfer?.files[0];
    if (file) handleFileUpload(file);
  });

  replaceAllBtn?.addEventListener('click', replaceAll);
  processBtn?.addEventListener('click', processAndDownload);

  backBtn?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
});
