export const EXECUTION_PAGE_SIZE = 10;

export type ExecutionPageWindow = {
  page: number;
  pageCount: number;
  start: number;
  end: number;
};

/**
 * Resolve the visible page window. `pageSize` is optional so every existing caller keeps the
 * historical ten-row grid; the opportunity boards pass their own page size instead.
 */
export function executionPageWindow(itemCount: number, requestedPage: number, pageSize: number = EXECUTION_PAGE_SIZE): ExecutionPageWindow {
  const safeItemCount = Math.max(0, Math.floor(itemCount));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(safeItemCount / safePageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage) || 1));
  const start = (page - 1) * safePageSize;
  return {
    page,
    pageCount,
    start,
    end: Math.min(start + safePageSize, safeItemCount),
  };
}
