import { useEffect, useState } from 'react';
import { planApi } from '../../services/api';

/**
 * Resolve a block's media into something a browser element can display.
 *
 * External links (http/https, data:, blob:) are used as-is. Uploaded plan media is an authenticated
 * API path, and an `<img src>` cannot carry the `X-API-Key`, so it is fetched through the request
 * layer and re-exposed as a local object URL — the same pattern as the chat status media preview.
 *
 * Kept out of the component module so fast refresh stays limited to components.
 */

export function isDirectMediaUrl(url: string): boolean {
  return /^(https?:|data:|blob:)/i.test(url.trim());
}

export interface ResolvedMedia {
  src: string | undefined;
  loading: boolean;
  error: boolean;
}

export function useResolvedMediaSrc(url: string): ResolvedMedia {
  const trimmed = url.trim();
  const [src, setSrc] = useState<string | undefined>(() =>
    trimmed !== '' && isDirectMediaUrl(trimmed) ? trimmed : undefined,
  );
  const [loading, setLoading] = useState(trimmed !== '' && !isDirectMediaUrl(trimmed));
  const [error, setError] = useState(false);

  useEffect(() => {
    if (trimmed === '' || isDirectMediaUrl(trimmed)) {
      setSrc(trimmed !== '' ? trimmed : undefined);
      setLoading(false);
      setError(false);
      return undefined;
    }

    let revoked = false;
    let objectUrl: string | undefined;
    setLoading(true);
    setError(false);
    planApi
      .getMediaBlob(trimmed)
      .then(blob => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setLoading(false);
      })
      .catch(() => {
        if (revoked) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [trimmed]);

  return { src, loading, error };
}
