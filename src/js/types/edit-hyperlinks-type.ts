import { PDFDict, PDFDocument } from 'pdf-lib';

export interface HyperlinkEntry {
  id: number;
  pageNumber: number; // 1-based, for display
  actionType: string | null; // 'URI' | 'GoTo' | 'GoToR' | 'Launch' | 'JavaScript' | null
  url: string; // editable value; only meaningful when actionType === 'URI'
  originalUrl: string;
  actionDict: PDFDict | null; // live dict ref, mutated directly on save when actionType === 'URI'
  editable: boolean;
}

export type ZoomMode =
  | 'keep'
  | 'none'
  | '50'
  | '75'
  | '100'
  | '125'
  | '150'
  | '200'
  | 'fit'
  | 'fith'
  | 'fitv';

export interface EditHyperlinksState {
  file: File | null;
  pdfDoc: PDFDocument | null;
  links: HyperlinkEntry[];
}
