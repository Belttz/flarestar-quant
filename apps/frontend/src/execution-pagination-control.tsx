import { useLanguage } from './i18n.js';
import { EXECUTION_PAGE_SIZE, executionPageWindow } from './execution-pagination.js';

/**
 * Page controls for a server-paged (or client-paged) table.
 *
 * `pageSize` defaults to the execution grid's ten rows so every existing caller is unchanged.
 * Passing `onPageSizeChange` turns the trailing static "N per page" text into a selector fed by
 * `pageSizeOptions`; the control then stays visible even when the current page holds fewer rows
 * than the page size, because the selector is the only way back to a denser view.
 */
export function ExecutionPagination({
  itemCount,
  page,
  onPageChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
}: {
  itemCount: number;
  page: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const { t } = useLanguage();
  const effectivePageSize = Math.max(1, Math.floor(pageSize ?? EXECUTION_PAGE_SIZE));
  // An empty table needs no pager, and a short table only needs one when the page size itself is
  // changeable — otherwise the selector would be the only way to a denser view.
  if (itemCount <= 0 || (itemCount < effectivePageSize && !onPageSizeChange)) return null;
  const window = executionPageWindow(itemCount, page, effectivePageSize);
  return <div className="funding-pagination execution-pagination"><span className="page-range">{window.start + 1}–{window.end} / {itemCount}</span><div className="page-controls"><button onClick={() => onPageChange(window.page - 1)} disabled={window.page <= 1}>{t('Prev')}</button><span className="page-indicator">{t('Page')} {window.page} / {window.pageCount}</span><button onClick={() => onPageChange(window.page + 1)} disabled={window.page >= window.pageCount}>{t('Next')}</button></div>{onPageSizeChange
    ? <label className="page-size"><select
      value={effectivePageSize}
      aria-label={t('Rows per page')}
      onChange={(event) => onPageSizeChange(Math.max(1, Math.floor(Number(event.target.value)) || effectivePageSize))}>
      {(pageSizeOptions ?? [effectivePageSize]).map((size) => <option key={size} value={size}>{size}</option>)}
    </select><span>{t('per page')}</span></label>
    : <span className="page-size">{effectivePageSize} {t('per page')}</span>}</div>;
}
