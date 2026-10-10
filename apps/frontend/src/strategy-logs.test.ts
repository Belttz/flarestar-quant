import { describe, expect, it } from 'vitest';
import {
  STRATEGY_LOG_CATEGORY_FETCH_EVENTS,
  STRATEGY_LOG_LEG_EVENT_PREFIXES,
} from '@gate-crossex/shared-types';
import { ApiError, type StrategyLog } from './api.js';
import {
  classifyStrategyLogEvent,
  describeStrategyLogError,
  groupStrategyLogs,
  isFilledLeg,
  localizeStrategyLogCondition,
  localizeStrategyLogResult,
  prepareStrategyLogs,
  prepareStrategyLogView,
  strategyLogRowCategory,
} from './strategy-logs.js';

function log(overrides: Partial<StrategyLog> & Pick<StrategyLog, 'id' | 'event'>): StrategyLog {
  return {
    level: 'info',
    condition: 'Premium 35.20% ≥ 35.00%',
    quantity: '0.1/0.1 SKHY',
    result: 'Filled',
    createdAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('strategy log grouping', () => {
  it('groups successful entry legs as one position-open execution', () => {
    const logs = [
      log({ id: 'right', event: 'Right leg filled', result: 'BUY hedge @ 1700' }),
      log({ id: 'left', event: 'Left leg filled', result: 'SELL ADR @ 230' }),
      log({ id: 'trigger', event: 'Entry triggered' }),
    ];

    expect(groupStrategyLogs(logs)).toEqual([
      expect.objectContaining({
        id: 'left:right',
        event: 'Position open Executed',
        result: 'SELL ADR @ 230 · BUY hedge @ 1700',
      }),
      logs[2],
    ]);
  });

  it('groups successful exit legs as one take-profit execution', () => {
    const condition = 'Premium 23.50% ≤ 24.00%';
    const logs = [
      log({ id: 'left-exit', event: 'Left leg filled', condition, result: 'BUY ADR @ 210' }),
      log({ id: 'right-exit', event: 'Right leg filled', condition, result: 'SELL hedge @ 1700' }),
      log({ id: 'trigger-exit', event: 'Take-profit triggered', condition }),
    ];

    expect(groupStrategyLogs(logs)[0]).toEqual(expect.objectContaining({
      event: 'Take-profit Executed',
      result: 'BUY ADR @ 210 · SELL hedge @ 1700',
    }));
  });

  it('keeps unmatched leg diagnostics separate', () => {
    const logs = [log({ id: 'left-only', event: 'Left leg filled' })];
    expect(groupStrategyLogs(logs)).toEqual(logs);
  });
});

describe('strategy log execution premium', () => {
  const premiumConfig = { kind: 'premium', adrRatio: '10', leftSide: 'SELL', rightSide: 'BUY' } as const;

  it('calculates the opening premium from a combined backend execution', () => {
    const logs = [log({
      id: 'open',
      event: 'Position open Executed',
      result: 'SELL GATE_FUTURE_SKHY_USDT 0.1 @ 229.9 · BUY GATE_FUTURE_SKHYNIX_USDT 0.01 @ 1700',
    })];

    expect(prepareStrategyLogs(logs, premiumConfig)[0]?.executionPremiumPct).toBe('35.24');
  });

  it('calculates the take-profit premium from a combined execution', () => {
    const logs = [log({
      id: 'exit',
      event: 'Take-profit Executed',
      result: 'BUY GATE_FUTURE_SKHY_USDT 0.1 @ 210 · SELL GATE_FUTURE_SKHYNIX_USDT 0.01 @ 1700',
    })];

    expect(prepareStrategyLogs(logs, premiumConfig)[0]?.executionPremiumPct).toBe('23.53');
  });

  it('calculates the premium from a reduce-only execution', () => {
    const logs = [log({
      id: 'reduce-only',
      event: 'Reduce-only Executed',
      result: 'BUY BINANCE_FUTURE_SKHY_USDT 10 @ 159.38 · SELL BINANCE_FUTURE_SKHYNIX_USDT 1.33 @ 1189.77',
    })];

    expect(prepareStrategyLogs(logs, premiumConfig)[0]?.executionPremiumPct).toBe('33.96');
  });

  it('calculates legacy grouped execution premiums and leaves diagnostics blank', () => {
    const logs = [
      log({ id: 'right', event: 'Right leg filled', result: 'BUY hedge · avg 1700' }),
      log({ id: 'left', event: 'Left leg filled', result: 'SELL ADR · avg 230' }),
      log({ id: 'trigger', event: 'Entry triggered' }),
    ];
    const prepared = prepareStrategyLogs(logs, premiumConfig);

    expect(prepared[0]?.executionPremiumPct).toBe('35.29');
    expect(prepared[1]?.executionPremiumPct).toBeNull();
  });
});

describe('strategy log execution spread', () => {
  it('calculates the actual hedge spread from the completed fill prices', () => {
    const logs = [log({
      id: 'open',
      event: 'Position open Executed',
      result: 'SELL DERIBIT_FUTURE_HYPE_USDC 10 @ 54.778 · BUY BYBIT_FUTURE_HYPE_USDT 10 @ 54.866',
    })];

    const prepared = prepareStrategyLogs(logs, {
      kind: 'position', leftSide: 'SELL', rightSide: 'BUY',
    });

    expect(prepared[0]?.executionSpreadBps).toBe('-16.04');
    expect(prepared[0]?.executionPremiumPct).toBeNull();
  });

  it('uses the configured sell leg when the hedge direction is reversed', () => {
    const logs = [log({
      id: 'open-reversed',
      event: 'Position open Executed',
      result: 'BUY LEFT_FUTURE_BTC_USDT 0.1 @ 100000 · SELL RIGHT_FUTURE_BTC_USDT 0.1 @ 100150',
    })];

    expect(prepareStrategyLogs(logs, {
      kind: 'auto', leftSide: 'BUY', rightSide: 'SELL',
    })[0]?.executionSpreadBps).toBe('15.00');
  });

  it('leaves non-execution rows without a derived spread', () => {
    const prepared = prepareStrategyLogs([
      log({ id: 'trigger', event: 'Entry triggered' }),
    ], { kind: 'position', leftSide: 'SELL', rightSide: 'BUY' });

    expect(prepared[0]?.executionSpreadBps).toBeNull();
  });
});

describe('strategy log localization', () => {
  it('localizes premium conditions only when Chinese is selected', () => {
    const condition = 'Premium 27.08% ≤ 28.00%';

    expect(localizeStrategyLogCondition(condition, 'zh')).toBe('溢价 27.08% ≤ 28.00%');
    expect(localizeStrategyLogCondition(condition, 'en')).toBe(condition);
  });

  it('localizes order sides in dynamic execution results', () => {
    const result = 'BUY GATE_FUTURE_SKHY_USDT 1 @ 144.81 · SELL GATE_FUTURE_SKHYNIX_USDT 0.127 @ 1139.9';

    expect(localizeStrategyLogResult(result, 'zh')).toBe(
      '买入 GATE_FUTURE_SKHY_USDT 1 @ 144.81 · 卖出 GATE_FUTURE_SKHYNIX_USDT 0.127 @ 1139.9',
    );
    expect(localizeStrategyLogResult(result, 'en')).toBe(result);
  });

  it('localizes the taker submission status', () => {
    expect(localizeStrategyLogResult('Submitting both taker legs', 'zh')).toBe('正在同时提交两条吃单委托');
  });

  it('localizes dynamic strategy lifecycle details', () => {
    expect(localizeStrategyLogResult(
      'Leverage 2× / 3× · reserved margin 120 of 500',
      'zh',
    )).toBe('杠杆 2× / 3× · 预留保证金 120 / 可用保证金 500');
    expect(localizeStrategyLogResult(
      'Stopped with unhedged residual 0.1 SKHY; review positions',
      'zh',
    )).toBe('已停止，存在未对冲剩余敞口 0.1 SKHY；请检查持仓');
  });
});

describe('strategy log event classification', () => {
  it('maps a representative event from each category', () => {
    expect(classifyStrategyLogEvent('Entry triggered')).toBe('execution');
    expect(classifyStrategyLogEvent('Take-profit triggered')).toBe('risk');
    expect(classifyStrategyLogEvent('Hedge order settled')).toBe('maker');
    expect(classifyStrategyLogEvent('Strategy started')).toBe('system');
  });

  it('routes every leg diagnostic to execution by prefix, including unseen states', () => {
    expect(classifyStrategyLogEvent('Left leg filled')).toBe('execution');
    expect(classifyStrategyLogEvent('Right leg partially_filled')).toBe('execution');
    expect(classifyStrategyLogEvent('Left leg cancelled')).toBe('execution');
    expect(classifyStrategyLogEvent('Right leg rejected')).toBe('execution');
    expect(classifyStrategyLogEvent('Right leg expired')).toBe('execution');
    // A future/gateway state the table has never seen still lands under open/close.
    expect(classifyStrategyLogEvent('Left leg reinstated')).toBe('execution');
    // States the engine really can emit that the enumerated table does not list. These are exactly
    // the rows a closed `event IN (...)` fetch set would hide from the execution tab.
    expect(classifyStrategyLogEvent('Left leg fail')).toBe('execution');
    expect(classifyStrategyLogEvent('Right leg fail')).toBe('execution');
    expect(classifyStrategyLogEvent('Left leg remote_not_found')).toBe('execution');
    expect(classifyStrategyLogEvent('Right leg open')).toBe('execution');
    expect(classifyStrategyLogEvent('Left leg pending_submit')).toBe('execution');
  });

  it('keeps the backend fetch set and the client classifier in agreement', () => {
    // The backend selects a category's rows with a mix of exact `event IN (...)` names and SQL LIKE
    // prefix patterns (`%` suffix). Both sides must derive the leg rule from the same constant, or a
    // leg row will be classified into a tab the backend never fetches it for.
    for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
      expect(classifyStrategyLogEvent(`${prefix}anything`)).toBe('execution');
    }
    for (const patterns of Object.values(STRATEGY_LOG_CATEGORY_FETCH_EVENTS)) {
      for (const entry of patterns) {
        if (!entry.endsWith('%')) continue;
        expect(STRATEGY_LOG_LEG_EVENT_PREFIXES.some((prefix) => `${prefix}%` === entry)).toBe(true);
      }
    }
    // `execution` and `risk` must both carry the leg patterns: risk alone loses a failed leg of a
    // take-profit clip, because that row is regrouped into `Take-profit Executed` (a risk row) and
    // is therefore filtered out of the execution tab.
    for (const category of ['execution', 'risk'] as const) {
      for (const prefix of STRATEGY_LOG_LEG_EVENT_PREFIXES) {
        expect(STRATEGY_LOG_CATEGORY_FETCH_EVENTS[category]).toContain(`${prefix}%`);
      }
    }
  });

  it('falls back to system for an unknown event so nothing is hidden', () => {
    expect(classifyStrategyLogEvent('Weird new event')).toBe('system');
    expect(classifyStrategyLogEvent('')).toBe('system');
  });

  it('classifies grouped rows through the synthetic event names', () => {
    expect(strategyLogRowCategory(log({ id: 'open', event: 'Position open Executed' }))).toBe('execution');
    expect(strategyLogRowCategory(log({ id: 'reduce', event: 'Reduce-only Executed' }))).toBe('execution');
    expect(strategyLogRowCategory(log({ id: 'exit', event: 'Take-profit Executed' }))).toBe('risk');
  });

  it('exports isFilledLeg for the grouping dependency', () => {
    expect(isFilledLeg(log({ id: 'l', event: 'Left leg filled' }))).toBe(true);
    expect(isFilledLeg(log({ id: 'r', event: 'Right leg filled' }))).toBe(true);
    expect(isFilledLeg(log({ id: 't', event: 'Entry triggered' }))).toBe(false);
  });
});

describe('prepareStrategyLogView category filtering', () => {
  it('filtering happens after grouping, so an out-of-order trigger row self-heals across pages', () => {
    const condition = 'Premium 23.50% ≤ 24.00%';
    const legs = [
      log({ id: 'left-exit', event: 'Left leg filled', condition, result: 'BUY ADR @ 210' }),
      log({ id: 'right-exit', event: 'Right leg filled', condition, result: 'SELL hedge @ 1700' }),
    ];

    // First page held only the two legs: they pair into a position-open clip.
    expect(prepareStrategyLogView(legs, 'execution').map((row) => row.event)).toEqual(['Position open Executed']);

    // The older trigger row arrives on the next page; regrouping the grown buffer switches the label.
    const grown = [...legs, log({ id: 'trigger-exit', event: 'Take-profit triggered', condition })];
    const riskEvents = prepareStrategyLogView(grown, 'risk').map((row) => row.event);
    expect(riskEvents[0]).toBe('Take-profit Executed');
    expect(riskEvents).not.toContain('Position open Executed');
    // The raw trigger row stays visible next to its grouped execution row.
    expect(riskEvents).toContain('Take-profit triggered');
  });

  it("keeps the category's own rows when a superset page carries unrelated dependency events", () => {
    const logs = [
      log({ id: 'rk', event: 'Stop-loss triggered' }),
      log({ id: 'mx', event: 'Maker quote placed' }),
      log({ id: 'sys', event: 'Strategy paused' }),
    ];

    expect(prepareStrategyLogView(logs, 'risk').map((row) => row.id)).toEqual(['rk']);
    expect(prepareStrategyLogView(logs, 'maker').map((row) => row.id)).toEqual(['mx']);
    expect(prepareStrategyLogView(logs, 'system').map((row) => row.id)).toEqual(['sys']);
    expect(prepareStrategyLogView(logs, 'all').map((row) => row.id)).toEqual(['rk', 'mx', 'sys']);
  });
});

describe('describeStrategyLogError', () => {
  it('maps transport-level ApiError codes to their user-facing bucket', () => {
    expect(describeStrategyLogError(new ApiError(0, 'backend_unavailable'))).toBe('network');
    expect(describeStrategyLogError(new ApiError(0, 'request_timeout'))).toBe('timeout');
    expect(describeStrategyLogError(new ApiError(0, 'request_cancelled'))).toBe('cancelled');
  });

  it('treats HTTP and non-ApiError failures as a backend error', () => {
    expect(describeStrategyLogError(new ApiError(500, 'request_failed'))).toBe('backend');
    expect(describeStrategyLogError(new ApiError(400, 'invalid_log_query'))).toBe('backend');
    expect(describeStrategyLogError(new Error('boom'))).toBe('backend');
    expect(describeStrategyLogError('nope')).toBe('backend');
  });
});
