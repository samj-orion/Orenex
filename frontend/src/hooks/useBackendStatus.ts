import { useEffect, useSyncExternalStore } from 'react';
import { getBackendStatus, pingBackend, subscribeBackend, type BackendStatus } from '../core/api';

/**
 * Live view of the ORENEX Python backend connection.
 *
 * Probes `/health` once on first use and then on an interval, so the UI can show
 * whether answers are coming from the Python engine or the local in-browser one.
 * The probe is deliberately cheap and never throws.
 */
export function useBackendStatus(pollMs = 30000): BackendStatus {
  const status = useSyncExternalStore(subscribeBackend, getBackendStatus);

  useEffect(() => {
    void pingBackend();
    if (pollMs <= 0) return;
    const id = setInterval(() => void pingBackend(), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  return status;
}
