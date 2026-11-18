/**
 * Ambient typing for the Vite client environment.
 *
 * The app deliberately does not pull in `vite/client`: `@types/node` already
 * augments `ImportMeta`, and the only `import.meta.env` field the app reads is
 * the backend base URL (see `src/core/api.ts`).
 */
interface ImportMetaEnv {
  /**
   * Base URL of the ORENEX Python backend, e.g. `http://127.0.0.1:8000`.
   * When unset the client falls back to that default.
   */
  readonly VITE_ORENEX_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
