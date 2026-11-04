declare module "*.css";

interface Window {
  STRATA_BUILD?: string;
  STRATA_BASE?: string;
  __strataPending?: number;
  __strataSent?: number;
  __strataSettled?: () => Promise<void>;
}
