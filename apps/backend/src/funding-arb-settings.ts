import { FundingArbSettingsSchema, type FundingArbSettings } from '@gate-crossex/shared-types';

/**
 * Defaults and validation for the automatic perp ⇄ perp funding runner.
 *
 * The wire schema lives in `@gate-crossex/shared-types` (single source for backend and frontend);
 * this module only adds the read/write helpers the backend needs. A stored row is always
 * re-validated: a corrupt or hand-edited settings object falls back to the defaults instead of
 * taking the scanner down, and missing fields are filled by the schema defaults.
 */
export const DEFAULT_FUNDING_ARB_SETTINGS: FundingArbSettings = FundingArbSettingsSchema.parse({});

export function parseFundingArbSettings(value: unknown): FundingArbSettings {
  const parsed = FundingArbSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_FUNDING_ARB_SETTINGS;
}

/** Merge a partial patch over the current settings, letting the schema re-apply defaults. */
export function mergeFundingArbSettings(
  current: FundingArbSettings,
  patch: Partial<FundingArbSettings>,
): FundingArbSettings {
  return parseFundingArbSettings({ ...current, ...patch });
}
