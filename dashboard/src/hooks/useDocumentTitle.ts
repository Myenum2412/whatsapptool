import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends " | MyWhatsapp" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | MyWhatsapp`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
